# /rf использует полноразмерный overlay

---
status: accepted
---

`/rf` и `/resume-fast` открывают `ctx.ui.custom()` с `overlay: true`, `width: "100%"`, `maxHeight: "100%"` и `margin: 0`. Внутри живут тонкая строка статуса и оригинальный `SessionSelectorComponent`, поэтому picker получает максимальную высоту терминала и визуально максимально близок к штатному `/resume`. Текущая сессия остаётся под overlay и возвращается без пересоздания после Esc; internal root `InteractiveMode` расширение не заменяет.
