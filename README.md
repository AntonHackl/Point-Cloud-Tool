# Point Cloud Tool

Local browser viewer for inspecting LAS and LAZ point clouds. Colors and instance selection are independent, so you can select an instance while looking at RGB or any other scalar field.

## Build and run on Windows

Install the stable MSVC Rust toolchain with [rustup](https://rustup.rs/), Visual Studio C++ Build Tools with a Windows SDK, and Node.js 22.12 or newer. From the repository root run:

```powershell
npm.cmd ci --prefix web
npm.cmd run build --prefix web
cargo run --release
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) in a browser with WebGL 2. Choose **Open file**, then choose a local LAS or LAZ file. Use **Color by** to inspect a scalar field and **Instance field** to select groups by label. Drag to orbit, right-drag to pan, and scroll to zoom.

After building, you can also double-click target/release/point-cloud-tool.exe in Explorer. Keep its terminal open while using the viewer.

The server binds to loopback and keeps one active plot in memory. Points retain their original LAS record index. The viewer centers coordinates for rendering. Instance labels remain exact, including 64-bit integers, and points with a declared missing label cannot be selected as an instance.

## Development

Run `cargo run --release` at the repository root and `npm.cmd run dev --prefix web` in a second terminal for Vite hot reload. Use the localhost URL printed by Vite. Run `cargo test` for reader regression checks and `npm.cmd run build --prefix web` for TypeScript and the production build.

## Milestone 1 benchmark

Tested the 2,580,086-point sample in Chrome on Windows with Intel UHD Graphics at a 1150 × 750 browser viewport. In one run, the first view took 3.34 s, a short orbit averaged 48 animation frames per second, and two instance clicks took 113 ms and 54 ms to update the highlight. The Rust server peaked at 193 MiB of working set, and the largest individual Chrome process peaked at 290 MiB. These are process working-set measurements, not GPU memory measurements.

Keep the full plot in memory for this dataset. Recheck performance on larger plots and the lowest-spec annotator machine before adding spatial chunking.

