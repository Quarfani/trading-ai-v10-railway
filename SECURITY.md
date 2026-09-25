# Security

## Implemented

- Startup validation for dashboard/session/operator secrets.
- Mainnet live trading requires an explicit acknowledgement environment variable.
- Operator and admin sessions are role separated.
- Control endpoints require authentication; sensitive training/walk-forward controls require admin.
- ML API anonymous access is disabled unless explicitly enabled for test/local use.
- MT5 bridge anonymous access is disabled by default.
- Request body size is bounded on the MT5 bridge.
- API CORS origins are configurable.
- Unresolved execution operations block startup.
- Logs are not intended to contain raw secrets.

## Not complete / blocked

- Full dependency vulnerability audit was not executed because Node dependencies could not be installed in the isolated environment.
- S3 backup upload currently uses a simplified bearer-style authorization path; it is not a production-grade AWS SigV4 implementation.
- No CI security pipeline was found.
- Full runtime penetration/load testing was not executed.
