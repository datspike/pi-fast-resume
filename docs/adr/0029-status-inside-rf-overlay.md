# Статусы fast-resume живут только внутри /rf overlay

---
status: accepted
---

`Index warming up… x/y`, статус lease и ошибки worker'а отображаются временной строкой внутри overlay `/rf`/`/resume-fast`, а не через общий footer Pi (`ctx.ui.setStatus`). Внешняя обёртка добавляет и обновляет эту строку, не трогая private internals `SessionSelectorComponent`; сам штатный picker остаётся неизменным дочерним компонентом. В устойчивом состоянии строка отсутствует, поэтому обычный UI остаётся максимально похож на оригинальный `/resume`.
