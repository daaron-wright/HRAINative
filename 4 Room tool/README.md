# Workshop room

A small web app for the workshop. People scan a QR code, type their name and a four-digit PIN, and answer on their phones. The room screen shows the results live. The facilitator opens, closes and reveals each activity from a console. It runs on one laptop, needs no internet and no accounts, and saves everything as it goes.

## What you need

- One laptop with Python 3. Check it the day before: open Terminal (Mac) or Command Prompt (Windows) and type `python3 --version` (on Windows, `py --version`). If it is missing, install Python 3 from python.org. That needs admin rights and the internet, so do it before the day.
- The laptop and the phones on the same Wi-Fi.
- A browser on the projector laptop (Chrome, Edge or Safari).

## Start it

- **Mac:** double-click `Start-Room.command`. If the Mac says it cannot open it, right-click it and choose Open.
- **Windows:** double-click `Start-Room.bat`.
- **Or** open a terminal in this folder and run `python3 room.py`.

It prints four addresses:

| Address | Open it on | What it shows |
|---|---|---|
| `/` | Everyone's phones, by QR code | The page people answer on |
| `/stage` | The projector. Press F for full screen | The join code, then the live results |
| `/host?key=…` | Your own laptop or tablet. Keep the key private | The facilitator console |
| `/print` | Any browser, then print | Join cards with the QR code, one per table |

The facilitator key stays the same when you restart. To choose your own, run `python3 room.py --key your-key`. If port 8080 is busy, run `python3 room.py --port 8090`.

## Test the Wi-Fi the day before

1. Start the room on the laptop and connect two phones to the venue Wi-Fi. Scan the join code.
2. If the phones cannot open the page, the Wi-Fi stops devices from seeing each other. This is common on guest networks.
3. Plan B: a travel router or a phone hotspot that the laptop and everyone joins.
4. Plan C: run it on any small cloud machine and start it with `--url https://that-address`.
5. Plan D: paper. Every activity has a paper version in the print kit.

## During the day

- **Open and show** puts an activity on the room screen and lets people answer. Opening another one closes the first.
- Check questions and the game stay hidden until you press **Show results**, so nobody copies the room. Opinion votes show live. Turn that off in Settings if people start following the crowd.
- **Hide** takes any answer off the room screen. You still see it, with the name.
- The **pulse** shows how many people are lost, or find the pace too fast, over the last ten minutes.
- The **questions** panel is the parking lot. Give each question an owner before the day ends.
- Someone changes phone: they type the same name and PIN. Someone forgets their PIN: give them a new one under People.
- The timer buttons put a countdown on the room screen.

## After each day

- **Export all** saves every answer as one JSON file. **Export CSV** on an activity saves just that one.
- Everything is also saved in `room-data.json` in this folder after every change. If the laptop restarts, start the room again and nothing is lost.
- For a rehearsal, use **Wipe everything** in the console afterwards, or delete `room-data.json` while the room is stopped.

## Privacy

Names appear on the room screen only where the room agrees a role, such as decision seats, and in game scores if you switch them on. The export and `room-data.json` hold names and answers. Keep them with the other workshop outputs, and delete them when they are no longer needed. PINs are stored hashed.

## Check that it works

`python3 tests/test_room.py` starts a test copy on port 8097 and runs 102 checks: 25 phones at once, every activity type, the facilitator actions, a restart and the exports.
