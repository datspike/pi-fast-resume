# Alt+G переключает видимость сабагентов

---
status: accepted
supersedes: hotkey portion of ADR-0007 and ADR-0026
---

Видимость сабагентных сессий в текущем picker overlay переключает `Alt+G`, а не `Ctrl+G`. `Ctrl+G` занят штатным Pi для `app.editor.external` (external editor), поэтому его захват расширением был бы хрупким конфликтом. `Alt+G` не пересекается с задокументированными controls session picker'а. Семантика фильтра не меняется: новый `/rf` стартует с `Agents: hidden`, переключение действует только до закрытия overlay.
