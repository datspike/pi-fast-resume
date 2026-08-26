# Первая рабочая версия подключается локальным package path

---
status: accepted
---

После полного набора проверок (`typecheck`, `lint`, `test`, Pi smoke) и немедленного Conventional Commit расширение подключается в `PiAgent/agent/settings.json` локальным package path `/home/spike/hobby/pi-fast-resume`. npm publish до стабилизации не выполняется. Такой rollout совпадает с существующими hobby-расширениями пользователя, допускает быстрые локальные правки и `/reload`, а runtime dependencies пакета разрешаются рядом с его `package.json`.
