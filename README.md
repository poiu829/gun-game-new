# SHADOW POINT Online (prototype)

A room-code multiplayer prototype for the SHADOW POINT game. It uses a Node.js WebSocket server and a canvas-based client.

## Features in this build

- Create a private room and invite others with a five-character room code or link.
- Up to six human players per room.
- The host can choose **CPUで補充して開始** (fill empty slots up to 3-vs-3 with CPUs) or **今いる人数で開始** (start with only the currently connected players).
- If a player disconnects during a match, that character is taken over by a CPU.
- Server-simulated movement, shooting, bullets, paintable territory, Shadow Point, respawning, scoring, and match timer.
- CPUs exclude enemies whose Shadow Point is exactly full from target selection.
- PC keyboard/mouse controls; touch controls appear where a finger first touches the screen.

This is a prototype: rooms are held in server memory and disappear when the service restarts or becomes idle. There is no account system or persistent match history.

## Run locally

You need Node.js 20 or later.

```bash
npm install
npm start
```

Then open <http://localhost:10000>. Do **not** open `public/index.html` directly as a file; the game needs the WebSocket server.

## Publish to the internet (Render)

The included `render.yaml` describes a web service. Render supports WebSocket connections for web services, so the gameplay server and page can run on the same public URL.

1. Extract this project folder.
2. Create a Git repository and upload the contents of this folder (the `package.json`, `server.js`, `render.yaml`, and `public` folder must be at the repository root).
3. In Render, choose **New → Blueprint** and connect that repository so it can read `render.yaml`. Alternatively, create a **Web Service** manually with build command `npm install` and start command `npm start`.
4. Wait for the deploy to finish, then open the `onrender.com` URL it provides.
5. Create a room and share the invite link or the five-character code with other players.

The free Render web-service plan may go idle after a period without traffic and take a little while to wake up again. This is suitable for testing, but not a guarantee of uninterrupted service. See Render's current docs:

- <https://render.com/docs/web-services>
- <https://render.com/docs/websocket>
- <https://render.com/docs/your-first-deploy>

## Controls

- PC: **WASD** or arrow keys to move; mouse to aim; hold the left mouse button to shoot.
- Touchscreens: touch the left half for the move stick, and the right half for aim/fire. Each stick is hidden until touched.

## Main settings

- World: 4800 × 912 logical units; grid: 24 units.
- Human movement: 95 units/s.
- Bullet speed: 180 units/s; lifetime: 0.45 s (nominal travel distance about 81 units).
- Hit damage: 27 Shadow Point; firing cost: 0.65; respawn delay: 1.7 s.
