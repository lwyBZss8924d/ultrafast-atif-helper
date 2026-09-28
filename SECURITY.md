# Security policy

Report issues using synthetic inputs and public source locations. Never post
credentials, real RAW histories, private local dataset paths or unredacted scorer
requests. Prefer the repository's private vulnerability-reporting channel if
enabled; otherwise open an issue requesting a private contact method without
sensitive details. No response SLA is promised for this pre-1.0 project.

Local ETL and exact retrieval do not require network access. Importing the helper
or installing its Skills plugin does not activate upstream remote compaction.
Review the separate transport contract before providing a network scorer.

Build and test dependencies are separate from the dependency-free runtime helper.
Keep development servers and browser/UI modes off unless they are part of an
explicit test. Report dependency advisories with affected package/version and the
exposed execution path rather than treating a passing unit suite as remediation.
