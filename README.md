# Волна для Windows

Десктопный клиент Яндекс Музыки: Моя волна с обучением, коллекция, поиск, текст песен
с подсветкой строки и ASCII-визуализатор за экраном волны. Порт iOS-приложения «Волна»
(`ymusic-ios`) на Rust.

## Запуск

Готовый файл: `target\release\volna.exe`. Двойной клик, больше ничего не нужно:
интерфейс вшит в exe, WebView2 уже есть в Windows 11.

Вход: «войти через яндекс» открывает окно Яндекс ID. После входа окно закроется само.
Если не закрылось, есть «вставить токен вручную».

## Сборка

Нужны Rust (toolchain `stable-x86_64-pc-windows-gnu`) и WinLibs MinGW (gcc и windres в PATH).

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo build --release   # target\release\volna.exe
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

Волна учится так же, как на iPhone: каждый трек отправляет `trackStarted` и
`trackFinished` или `skip` в rotor-сессию. Каждое прослушивание уходит в `play-audio`
с `from=radio-mobile-user-onyourwave`.

Что ещё не сделано, перечислено в `BACKLOG.md`, раздел «Долги».

## Лицензия

MIT. Шрифт Dela Gothic One — SIL OFL (`ui/fonts/OFL-DelaGothicOne.txt`).
