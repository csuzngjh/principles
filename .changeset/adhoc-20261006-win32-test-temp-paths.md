---
---

Test-only change: installer test fixtures now derive their workspace pointer
from the governed test temp root instead of a literal `/tmp/...`, so the
install-entry workspace validator stops refusing them on Windows before the
behavior under test is reached. Nothing shipped changes.
