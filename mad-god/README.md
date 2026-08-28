# Mad God / Shen Ye Feng Kuang

Single-player browser god game. Original code and art only.

## Run
Vite plus TypeScript plus Three.js. Default port 5173.

## Play
Blue deity versus red AI on one grassy island with water.
Raise and lower land. Flat 3x3 hut, 5x5 house, 7x7 castle.
Walkers settle empty flats and may merge. Mana from people and homes.
Houses hold 2/5/10 residents by level; more residents breed faster,
with a green progress bar over producing huts.
Units have attack, armor, attack interval and counter stats; melee hits
are cooldown-gated single strikes (see design/COMBAT.md).
Train warriors with T, preachers with Y, firewarriors with G, spies with H.
If the shaman is lost, send a follower to the ankh (order V).
Win when the other side has no people and no houses.
Enemy planner ticks about once a second.

## Controls
Left click or drag: raise land or selected spell. Right click: lower.
WASD pan, wheel zoom, Q/E or middle-mouse rotate, Space pause.
1-7 tools. Z settle, X gather, C fight, V shaman.
Click the minimap to jump the camera.

## 神迹 Spells
Lightning 20. Earthquake 50 (cap 120). Swamp 36 (cap 140).
Volcano 80 (cap 160). Armageddon 100 (cap 200).

## 中文摘要
你是蓝方神明，对阵红方敌神。提升土地让子民筑屋，扩建平台可升级屋宇。
法力随人口与屋宇增长。数字键选神迹，Z X C V 谕令，T Y G H 征召武士 / 传教士 / 火战士 / 间谍。空格暂停。
消灭对方全部子民与屋宇即胜。项目入口：index.html 与 src/main.ts。
Use the package scripts named dev, build, and preview.
