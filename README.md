# PCB CNC Simulator

Web-based **3D PCB CNC G-code simulator** for FlatCAM `.nc` files. Shows the expected final board (copper + FR4 after milling), not only toolpath lines.

## Run

```bash
npm install
npm run dev
```

Open the app, then **Load sample** (or it auto-loads `00000_gcode-test-F_Cu.gbr_iso_combined_cnc.nc`).

## Features

- V-bit / end-mill / drill tools with depth-dependent V-bit width  
  `effectiveDiameter = tipDiameter + 2 × depth × tan(angle / 2)`
- **FlatCAM Tool Dia helper** (side panel): V tip width ≠ FlatCAM Tool Dia (effective width at Cut Z)
- Height-field material removal (copper mask + cut depth)
- Final PCB, toolpaths, heatmap, and combined views
- Multi-file jobs on one stock
- Playback, warnings, and distance measurement
- G-code parsing in a Web Worker

## FlatCAM Tool Dia vs V tip width

FlatCAM’s **Tool Dia** is the **effective cutting width at Cut Z**, used for isolation offsets. It is **not** the physical V-tip width and not the shank (e.g. 3.175 mm).

```
FlatCAM Tool Dia = V tip width + 2 × |Cut Z| × tan(angle / 2)
```

## Sample test

```bash
npm run test:sample
```

The bundled isolation sample comments `TOOL DIAMETER: 0.05 mm` with `Z_Cut: 0.0933 mm` → at 30° that implies tip ≈ **0 mm** and effective groove ≈ **0.050 mm**.
