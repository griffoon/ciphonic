# C1PH0N1C

Десктопный клиент Яндекс Музыки для Windows (раньше «Волна»): Моя волна, коллекция, поиск,
текст как в караоке, отделение голоса, найткор и slowed + reverb, ASCII-визуализатор из 0 и 1.
Порт iOS-приложения на Rust. Сайт: https://griffoon.github.io/ciphonic/

## Запуск

Скачай `C1PH0N1C-…-windows-x64.zip` со страницы релизов, распакуй и запусти `ciphonic.exe`.
`WebView2Loader.dll` должен лежать в той же папке. Интерфейс вшит в exe.

- Нужна Windows 10 или 11 (64-бит) и WebView2 Runtime. В Windows 11 он уже есть,
  в Windows 10 обычно ставится вместе с Edge.
- Exe не подписан, поэтому SmartScreen покажет «Windows защитила ваш компьютер»:
  «Подробнее» → «Выполнить в любом случае».
- Нужен свой аккаунт Яндекса с Плюсом. Токен хранится только в Windows Credential Manager
  этого компьютера.

Вход: «войти через яндекс» открывает окно Яндекс ID. После входа окно закроется само.
Если не закрылось, есть «вставить токен вручную».

## Сборка

Нужны Rust (toolchain `stable-x86_64-pc-windows-gnu`) и WinLibs MinGW (gcc и windres в PATH).

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo build --release   # target\release\ciphonic.exe
cargo run               # отладочная сборка с консолью для логов
cargo test              # криптография, LRC, волна, анализатор
```

## Как устроено

Стек — Tauri 2. Всё, что про звук, сеть и ключи, живёт в Rust. Интерфейс рисует
WebView2: так дешевле всего получить плавные пружинные анимации и шейдер на GPU.

| Модуль | Что делает | Откуда портировано |
|---|---|---|
| `src/auth.rs` | OAuth во вебвью, токен в Credential Manager | `Auth/LoginView.swift` |
| `src/api.rs` | клиент `api.music.yandex.net`, `play-audio` | `API/YMClient.swift` |
| `src/stream.rs` | `get-file-info` + AES-CTR, MP3 через MD5-соль | `API/StreamResolver.swift` |
| `src/player.rs` | symphonia → буфер → cpal (WASAPI) | `Player/PlayerEngine.swift` |
| `src/wave.rs` | rotor-сессия и обратная связь | `Player/WaveSession.swift` |
| `src/lyrics.rs` | Yandex LRC/TEXT, LRCLIB, разбор LRC | `Player/Lyrics.swift`, `API/LRCLib.swift` |
| `src/analysis.rs` | FFT, полосы, удары, кик → событие `levels` | `Player/AudioAnalyzer.swift` |
| `src/media.rs` | медиаклавиши и флайаут Windows (SMTC) | — |
| `ui/visualizer.js` | WebGL2-шейдер: ASCII-дыхание и «Дым» | `Visual/CoverVisualizer.swift` |

Волна учится так же, как в мобильном приложении: каждый трек отправляет `trackStarted` и
`trackFinished` или `skip` в rotor-сессию. Каждое прослушивание уходит в `play-audio`
с `from=radio-mobile-user-onyourwave`.

Что ещё не сделано, перечислено в `BACKLOG.md`, раздел «Долги».

## Лицензия

MIT. Шрифт Dela Gothic One — SIL OFL (`ui/fonts/OFL-DelaGothicOne.txt`).
