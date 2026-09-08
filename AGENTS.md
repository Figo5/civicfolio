# Civicfolio

Personal localhost investment research app. This is a separate project from FairwayOS; do not touch that repository or its running jobs.

Build a reviewable first version with portfolio dashboard, disclosure feed, source-cited research chat, watchlists, and paper trade journal. No live orders, brokerage login, or secrets in prompts. Never fabricate live data: provide clearly labeled demo data alongside real-data adapters and show source timestamps and data mode. Political disclosures are delayed, amount ranges are not exact amounts, and reported transactions are not complete current holdings. Backtests must use publication availability dates.

Use GLM-5.3-Flash for implementation. Write a handoff describing exact commands, test results, implementation gaps, data sources and configuration. Do not delegate recursively or publish to GitHub; the coordinator will review publication separately. Bind the server to localhost. Use environment variables or OS credential storage for secrets, never browser localStorage. Keep brokerage execution disabled. No purchases or paid subscriptions.
