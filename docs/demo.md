# Five-minute MVP demo

1. Show `npm run format:check`, `npm run lint`, `npm run typecheck`, and `npm test`; explain that PostgreSQL verification is separate.
2. Open `/api/docs`, `/api/v1/health`, and `/api/v1/health/ready`.
3. Register two patients. Use the bootstrapped admin to promote one through `POST /admin/doctors`; log that account in again for a doctor-role token.
4. As doctor, create a future offset-aware slot. Show the public doctor search and availability result.
5. As patient, book with `Idempotency-Key: demo-booking-1`. Repeat it to show replay, then reuse the key with another payload to show `409`. Explain the slot lock and partial unique index.
6. As doctor, transition with unique idempotency keys to `in_progress` and `completed`, then issue a prescription. As patient, read it and create a record-only payment attempt.
7. As admin, show bounded analytics. End with limitations: no MFA challenge, real gateway, outbox worker, or claimed load result.

Never display `.env`, passwords, tokens, connection strings, clinical notes, or other patient data in a recorded demo.
