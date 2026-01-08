# Backend notes

## Push notifications (FCM v1)

This backend uses Firebase Admin SDK to send FCM v1 messages. You must provide a service account credential.

Options to provide credentials:

1. Set `GOOGLE_APPLICATION_CREDENTIALS` to the absolute path of your service account JSON file, or

2. Set `FIREBASE_SERVICE_ACCOUNT` to a relative JSON filename placed in the `Backend/` folder.

Example .env

```bash
DB_CONNECTION_STRING=mongodb://127.0.0.1:27017/easy_app
PORT=3000
# Either of the following works (prefer GOOGLE_APPLICATION_CREDENTIALS):
GOOGLE_APPLICATION_CREDENTIALS=./easy-grocery-521d5-firebase-adminsdk-fbsvc-8df3f201df.json
# FIREBASE_SERVICE_ACCOUNT=serviceAccount.json
```

Notes:

- Legacy `FCM_SERVER_KEY` is no longer used. Admin SDK handles OAuth and v1 endpoints.
- If no credentials are found, the server will skip sending push notifications but continue to operate.

## Additional Environment Variables

Optional flags useful during development / migrations:

```bash
DEBUG_UPSERT=1          # Log detailed payloads inside upsertClient controller
ALLOW_PHONE_CLAIM=1     # Allow adopting a legacy Client document that has matching phone but no firebase_uid (or orphan placeholder)
```

Disable these in production unless actively troubleshooting.
