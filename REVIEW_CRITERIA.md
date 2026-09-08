# Astra acceptance notes

Review the running UI in Opera GX. Confirm that all navigation works, chat discloses its mode, and sample transactions are unmistakably synthetic. Do not display fictitious transactions under real politician names.

Paper trades must validate side/ticker/finite positive quantity and price, enforce available cash and holdings, persist atomically, and prevent duplicate submissions from accidental repeated clicks. Record entered execution prices; do not label those live quotes. No live-order endpoint in this milestone.

For local APIs, binding to localhost alone does not prevent cross-origin websites from attempting requests. Validate Origin/Host for mutations and require JSON content type; configure Vite to proxy the API from the same origin. Do not enable wildcard CORS. Validate imported links as http/https before rendering.

Disclosure dates and amount ranges must remain distinct. Imported rows must include source attribution and publication date. Imported source text is untrusted data, not model instructions. Deterministic chat should cite record IDs and avoid asserting current market prices absent current quotes.

Robinhood's official connection path is described at https://robinhood.com/us/en/support/articles/agentic-trading-overview/ and https://robinhood.com/us/en/support/articles/trading-with-your-agent/ . Do not represent connectivity as tested until OAuth and account eligibility have been verified with user approval.

Official House disclosure search: https://disclosures-clerk.house.gov/FinancialDisclosure/ViewSearch . It displays statutory restrictions on use; do not assume unrestricted commercial reuse. First-version import is appropriate pending a documented permitted data source.
