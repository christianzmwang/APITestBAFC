# Pike13 Custom Field Updater

Simple Node.js server for updating USA Fencing membership numbers via Pike13 API.

## Features

- OAuth authentication with Pike13
- Two PATCH methods for updating custom fields (Method 2 array syntax as primary)
- Automatic USA Fencing field detection
- Token persistence across sessions

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env.local` file:
```env
PIKE13_SUBDOMAIN=your-subdomain
CLIENT_ID=your-client-id
CLIENT_SECRET=your-client-secret
REDIRECT_URI=http://localhost:3000/auth/pike13/callback
USA_FENCING_FIELD_NAME=USA Fencing Membership number
PORT=3000
```

3. Start the server:
```bash
node index.js
```

4. Visit `http://localhost:3000/auth` to authenticate

## API Endpoints

### Update Membership Number
```bash
POST /update-membership
Content-Type: application/json

{
  "person_id": 13156858,
  "value": "101118977"
}
```

### Update Home Location
```bash
POST /update-location
Content-Type: application/json

{
  "person_id": 13156858,
  "location_id": 38352
}
```

### Get Available Locations
```bash
GET /locations
```

### Test Custom Field Methods
```bash
GET /test-methods?person_id=13156858&value=101118977
```

### Test Location Update Methods
```bash
GET /test-location?person_id=13156858&location_id=38352
```

## Methods

### Custom Field Updates

The server supports two PATCH methods for updating custom fields:

#### Method 1: Object Syntax (Fallback)
```json
{
  "person": {
    "custom_fields": {
      "174661": "101118977"
    }
  }
}
```

#### Method 2: Array Syntax (Primary - Most Reliable)
```json
{
  "person": {
    "custom_fields": [
      { "id": 174661, "value": "101118977" }
    ]
  }
}
```

The server automatically uses Method 2 (array syntax) as the primary method and falls back to Method 1 if needed.

### Location Updates

Home location can be updated using either field name:

#### Method 1: location_id (Primary)
```json
{
  "person": {
    "location_id": 38352
  }
}
```

#### Method 2: home_location_id (Alternative)
```json
{
  "person": {
    "home_location_id": 38352
  }
}
```

Both methods work reliably. The `/update-location` endpoint uses Method 1 by default.
