# Статусы fast-resume живут только внутри /rf overlay

---
status: accepted
---

`Index warming up… x/y`, наблюдение за чужой lease и ошибки worker'а отображаются временной строкой внутри overlay `/rf`/`/resume-fast`, а не через общий footer Pi (`ctx.ui.setStatus`). После асинхронного изменения статуса или списка внешняя обёртка явно вызывает `tui.requestRender()`, не трогая private internals `SessionSelectorComponent`; сам штатный picker остаётся неизменным дочерним компонентом. В устойчивом состоянии строка отсутствует, поэтому обычный UI остаётся максимально похожим на оригинальный `/resume`.
