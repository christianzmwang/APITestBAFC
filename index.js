const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const session = require('cookie-session');
const open = require('open');
const fs = require('fs');

dotenv.config({ path: '.env.local' });

const app = express();
app.use(express.json());
app.use(session({ name: 'sess', keys: ['k1','k2'], maxAge: 24*60*60*1000 }));

const PORT = process.env.PORT || 3000;
const SUB = process.env.PIKE13_SUBDOMAIN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/auth/pike13/callback';

function baseUrl() {
  if (!SUB) throw new Error('PIKE13_SUBDOMAIN not set');
  return `https://${SUB}.pike13.com`;
}

function authzUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code'
  });
  return `${baseUrl()}/oauth/authorize?${params}`;
}

async function exchangeCodeForToken(code) {
  const url = `${baseUrl()}/oauth/token`;
  const data = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  };
  const res = await axios.post(url, data, { headers: { 'Content-Type': 'application/json' } });
  return res.data;
}

async function getDesk(path, accessToken, params = {}) {
  const url = `${baseUrl()}/api/v2/desk${path}`;
  const res = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` }, params });
  return res.data;
}

async function patchDesk(path, accessToken, payload) {
  const url = `${baseUrl()}/api/v2/desk${path}`;
  const res = await axios.patch(url, payload, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } });
  return res.data;
}

function getAccessTokenFromSessionOrFile(req) {
  let accessToken = req.session?.accessToken;
  if (!accessToken) {
    try {
      const raw = fs.readFileSync(`${__dirname}/last_token.json`, 'utf8');
      const tok = JSON.parse(raw);
      accessToken = tok.access_token;
    } catch {}
  }
  return accessToken;
}

function getFieldDisplayName(field) {
  return field.name || field.label || field.title || '';
}

async function findCustomFieldByName(accessToken, name) {
  const data = await getDesk('/custom_fields', accessToken);
  const fields = data.custom_fields || [];
  return fields.find(f => (f.name || f.label || f.title) === name);
}

function scoreUsaFencingFieldName(name) {
  const n = (name || '').toLowerCase();
  if (!n) return 0;
  let score = 0;
  if (n === 'usa fencing membership number') score += 10;
  if (n === 'usfa number') score += 8;
  if (n.includes('usa') && n.includes('fenc')) score += 5;
  if (n.includes('usfa')) score += 4;
  if (n.includes('membership')) score += 3;
  if (n.includes('member')) score += 2;
  if (n.includes('number') || n.includes('no') || n.includes('id')) score += 1;
  return score;
}

async function resolveUsaFencingField(accessToken) {
  const data = await getDesk('/custom_fields', accessToken);
  const fields = data.custom_fields || [];
  let best = null;
  let bestScore = -1;
  for (const f of fields) {
    const name = getFieldDisplayName(f);
    const s = scoreUsaFencingFieldName(name);
    if (s > bestScore) {
      best = f;
      bestScore = s;
    }
  }
  return bestScore > 0 ? best : null;
}

async function getPerson(accessToken, personId) {
  const data = await getDesk(`/people/${personId}`, accessToken);
  return (data.people && data.people[0]) || null;
}

// Update custom field using Method 1 (object with field ID as key)
async function updateCustomFieldMethod1(accessToken, personId, customFieldId, value) {
  const payload = {
    person: {
      custom_fields: {
        [customFieldId]: value
      }
    }
  };
  await patchDesk(`/people/${personId}`, accessToken, payload);
  const after = await getPerson(accessToken, personId);
  const cfList = after?.custom_fields || [];
  const match = cfList.find(cf => cf.custom_field_id === customFieldId);
  return {
    success: match?.value === value,
    resultValue: match?.value || null,
    person: after
  };
}

// Update custom field using Method 2 (array with id and value) - PRIMARY METHOD
async function updateCustomFieldMethod2(accessToken, personId, customFieldId, value) {
  const payload = {
    person: {
      custom_fields: [
        { id: customFieldId, value: value }
      ]
    }
  };
  await patchDesk(`/people/${personId}`, accessToken, payload);
  const after = await getPerson(accessToken, personId);
  const cfList = after?.custom_fields || [];
  const match = cfList.find(cf => cf.custom_field_id === customFieldId);
  return {
    success: match?.value === value,
    resultValue: match?.value || null,
    person: after
  };
}

// Update custom field - uses Method 2 (array syntax) as primary, Method 1 as fallback
async function updateCustomField(accessToken, personId, customFieldId, value) {
  try {
    const result = await updateCustomFieldMethod2(accessToken, personId, customFieldId, value);
    if (result.success) {
      return { method: 2, ...result };
    }
  } catch (e) {
    console.log('Method 2 failed, trying Method 1:', e.message);
  }
  
  // Fallback to Method 1
  const result = await updateCustomFieldMethod1(accessToken, personId, customFieldId, value);
  return { method: 1, ...result };
}

// Routes
app.get('/', (req, res) => {
  res.send('Pike13 Custom Field Updater. Visit /auth to authenticate.');
});

app.get('/auth', (req, res) => {
  res.redirect(authzUrl());
});

app.get('/auth/pike13/callback', async (req, res) => {
  try {
    const { code, error, error_description } = req.query;
    if (error) return res.status(400).send(`OAuth error: ${error} ${error_description || ''}`);
    if (!code) return res.status(400).send('Missing code');
    const token = await exchangeCodeForToken(code);
    req.session.accessToken = token.access_token;
    try {
      fs.writeFileSync(`${__dirname}/last_token.json`, JSON.stringify(token, null, 2));
    } catch {}
    res.send('Authorized! You can now use the API endpoints.');
  } catch (e) {
    res.status(500).send(e.response?.data || e.message);
  }
});

// Update USA Fencing membership number for a person
// POST /update-membership { person_id: number, value: string }
app.post('/update-membership', async (req, res) => {
  try {
    const accessToken = getAccessTokenFromSessionOrFile(req);
    if (!accessToken) return res.status(401).send('Not authorized. Visit /auth first.');

    const { person_id, value } = req.body || {};
    if (!person_id || !value) return res.status(400).send('Provide person_id and value');

    // Resolve USA Fencing field
    let field;
    const envFieldName = process.env.USA_FENCING_FIELD_NAME;
    if (envFieldName) field = await findCustomFieldByName(accessToken, envFieldName);
    if (!field) field = await resolveUsaFencingField(accessToken);
    if (!field) return res.status(404).send('USA Fencing custom field not found.');

    const before = await getPerson(accessToken, person_id);
    const result = await updateCustomField(accessToken, person_id, field.id, value);

    res.json({
      success: result.success,
      method_used: result.method,
      field: { id: field.id, name: getFieldDisplayName(field) },
      person_id,
      value,
      result_value: result.resultValue,
      before_custom_fields: before?.custom_fields || [],
      after_custom_fields: result.person?.custom_fields || []
    });
  } catch (e) {
    res.status(500).send(e.response?.data || e.message);
  }
});

// Test both methods side by side
// GET /test-methods?person_id=123&value=456
app.get('/test-methods', async (req, res) => {
  try {
    const accessToken = getAccessTokenFromSessionOrFile(req);
    if (!accessToken) return res.status(401).send('Not authorized. Visit /auth first.');

    const personId = req.query.person_id;
    const testValue = req.query.value;
    if (!personId || !testValue) return res.status(400).send('Provide person_id and value');

    // Resolve USA Fencing field
    let field;
    const envFieldName = process.env.USA_FENCING_FIELD_NAME;
    if (envFieldName) field = await findCustomFieldByName(accessToken, envFieldName);
    if (!field) field = await resolveUsaFencingField(accessToken);
    if (!field) return res.status(404).send('USA Fencing custom field not found.');

    const results = { field: { id: field.id, name: getFieldDisplayName(field) }, person_id: personId, test_value: testValue, methods: [] };

    // Test Method 1
    try {
      const result1 = await updateCustomFieldMethod1(accessToken, personId, field.id, testValue);
      results.methods.push({
        method: 1,
        description: 'custom_fields as object with field ID as key',
        success: result1.success,
        result_value: result1.resultValue
      });
    } catch (e) {
      results.methods.push({
        method: 1,
        description: 'custom_fields as object with field ID as key',
        error: e.response?.data || e.message
      });
    }

    // Test Method 2
    try {
      const result2 = await updateCustomFieldMethod2(accessToken, personId, field.id, testValue);
      results.methods.push({
        method: 2,
        description: 'custom_fields as array with id and value (PRIMARY - MOST RELIABLE)',
        success: result2.success,
        result_value: result2.resultValue
      });
    } catch (e) {
      results.methods.push({
        method: 2,
        description: 'custom_fields as array with id and value (PRIMARY - MOST RELIABLE)',
        error: e.response?.data || e.message
      });
    }

    res.json(results);
  } catch (e) {
    res.status(500).send(e.response?.data || e.message);
  }
});

// Test updating person's home location
// GET /test-location?person_id=123&location_id=456
app.get('/test-location', async (req, res) => {
  try {
    const accessToken = getAccessTokenFromSessionOrFile(req);
    if (!accessToken) return res.status(401).send('Not authorized. Visit /auth first.');

    const personId = req.query.person_id;
    const locationId = req.query.location_id;
    if (!personId) return res.status(400).send('Provide person_id');

    // Get current person data
    const before = await getPerson(accessToken, personId);
    
    const result = {
      person_id: personId,
      before: {
        location_id: before?.location_id,
        address: before?.address,
        street_address: before?.street_address,
        city: before?.city,
        state_code: before?.state_code,
        postal_code: before?.postal_code,
        country_code: before?.country_code
      },
      methods: []
    };

    // If location_id provided, try to update it
    if (locationId) {
      // Method 1: Try updating location_id directly
      try {
        const payload1 = {
          person: {
            location_id: parseInt(locationId)
          }
        };
        await patchDesk(`/people/${personId}`, accessToken, payload1);
        const after1 = await getPerson(accessToken, personId);
        result.methods.push({
          method: 1,
          description: 'Update location_id directly',
          payload: payload1,
          success: after1?.location_id == locationId,
          result_location_id: after1?.location_id
        });
      } catch (e) {
        result.methods.push({
          method: 1,
          description: 'Update location_id directly',
          error: e.response?.data || e.message
        });
      }

      // Method 2: Try updating with home_location_id
      try {
        const payload2 = {
          person: {
            home_location_id: parseInt(locationId)
          }
        };
        await patchDesk(`/people/${personId}`, accessToken, payload2);
        const after2 = await getPerson(accessToken, personId);
        result.methods.push({
          method: 2,
          description: 'Update home_location_id',
          payload: payload2,
          success: after2?.location_id == locationId,
          result_location_id: after2?.location_id
        });
      } catch (e) {
        result.methods.push({
          method: 2,
          description: 'Update home_location_id',
          error: e.response?.data || e.message
        });
      }

      // Get final state
      const after = await getPerson(accessToken, personId);
      result.after = {
        location_id: after?.location_id,
        address: after?.address,
        street_address: after?.street_address,
        city: after?.city,
        state_code: after?.state_code,
        postal_code: after?.postal_code,
        country_code: after?.country_code
      };
    }

    res.json(result);
  } catch (e) {
    res.status(500).send(e.response?.data || e.message);
  }
});

// Get available locations
app.get('/locations', async (req, res) => {
  try {
    const accessToken = getAccessTokenFromSessionOrFile(req);
    if (!accessToken) return res.status(401).send('Not authorized. Visit /auth first.');

    const data = await getDesk('/locations', accessToken);
    const locations = (data.locations || []).map(loc => ({
      id: loc.id,
      name: loc.name,
      address: loc.address
    }));
    res.json({ count: locations.length, locations });
  } catch (e) {
    res.status(500).send(e.response?.data || e.message);
  }
});

// Update person's home location
// POST /update-location { person_id: number, location_id: number }
app.post('/update-location', async (req, res) => {
  try {
    const accessToken = getAccessTokenFromSessionOrFile(req);
    if (!accessToken) return res.status(401).send('Not authorized. Visit /auth first.');

    const { person_id, location_id } = req.body || {};
    if (!person_id || !location_id) return res.status(400).send('Provide person_id and location_id');

    const before = await getPerson(accessToken, person_id);
    
    // Update using location_id field
    const payload = {
      person: {
        location_id: parseInt(location_id)
      }
    };
    await patchDesk(`/people/${person_id}`, accessToken, payload);
    const after = await getPerson(accessToken, person_id);

    res.json({
      success: after?.location_id == location_id,
      person_id,
      location_id,
      before_location_id: before?.location_id,
      after_location_id: after?.location_id
    });
  } catch (e) {
    res.status(500).send(e.response?.data || e.message);
  }
});

app.listen(PORT, async () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  try { await open(`http://localhost:${PORT}`); } catch {}
});