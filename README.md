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

On startup, the server preloads `Documents/Uni/Spatial_Data_Analysis/for-instance/NIBIO/dev_plot.laz` from your Windows user profile if the file exists. This is the working copy of `plot_22_annotated.laz`. Set `POINT_CLOUD_DEFAULT_FILE` before starting the server to use a different LAS or LAZ file. The viewer opens the preloaded plot on each refresh and starts with **Color by** set to intensity and **Color scale** set to **Gradient**.

Turn on **Lasso** and left-click to place at least three vertices. The shaded area follows the cursor as you draw. Right-click or use **Finish** to select the points through the depth of the view. To limit it to one tree, pick an instance field, click the tree, and enable **Active tree only**. Turn off Lasso after finishing to orbit with the selection still visible, or use **Clear** to remove it.

Press **X** to toggle Lasso, **C** to clear the selection, or **A** to toggle Active tree only. The crosshair in navigation mode marks where the viewer looks for the orbit pivot. When both mouse buttons are held, the most recently pressed button controls navigation.

The server binds to loopback and keeps the preloaded plot and the most recent manual upload in memory. Points retain their original LAS record index. The viewer centers coordinates for rendering. Instance labels remain exact, including 64-bit integers, and points with a declared missing label cannot be selected as an instance.

## Development

Run `cargo run --release` at the repository root and `npm.cmd run dev --prefix web` in a second terminal for Vite hot reload. Use the localhost URL printed by Vite. Run `cargo test` for reader regression checks and `npm.cmd run build --prefix web` for TypeScript and the production build.

## Milestone 1 benchmark

Tested the 2,580,086-point sample in Chrome on Windows with Intel UHD Graphics at a 1150 × 750 browser viewport. In one run, the first view took 3.34 s, a short orbit averaged 48 animation frames per second, and two instance clicks took 113 ms and 54 ms to update the highlight. The Rust server peaked at 193 MiB of working set, and the largest individual Chrome process peaked at 290 MiB. These are process working-set measurements, not GPU memory measurements.

Keep the full plot in memory for this dataset. Recheck performance on larger plots and the lowest-spec annotator machine before adding spatial chunking.

