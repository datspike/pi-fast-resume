# Проверки строятся на synthetic fixtures и Pi smoke

---
status: accepted
---

Автоматические проверки используют только искусственные JSONL-fixtures в `test/fixtures/`; приватные session-файлы пользователя в репозиторий не копируются. `node --test` покрывает parser, `size`+`mtime` diff, 25-file checkpoint, lease, pre-read fingerprint, subagent filter и schema rebuild. Отдельный smoke через `pi -e ./src/index.ts` проверяет `/rf`, `/rf reindex`, resume, Ctrl+G, rename и delete на временном session-dir. Реальный корпус допустим только как ручной локальный performance-smoke и не становится тестовым артефактом.
