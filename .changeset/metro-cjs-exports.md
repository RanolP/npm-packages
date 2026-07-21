---
'soonloh': patch
---

Add a `default` condition to every `exports` subpath so `require('soonloh/metro')` resolves from CJS metro configs instead of throwing ERR_PACKAGE_PATH_NOT_EXPORTED
