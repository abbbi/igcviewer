# IGC Parser + 3D Flight Viewer

![Alt text](viewer.jpg?raw=true "Title")

This project includes:
- A Go parser for `.igc` flight logs
- A local web server with API endpoints
- A browser frontend that renders the flight route on 3D terrain

## Run

```bash
 ./igcviewer
```

Then open:

`http://localhost:8080`

Upload an `.igc` file in the page header and click `Upload`.

## API

- `POST /api/flight` -> upload and parse IGC file

Multipart form field name:
- `igc` (the uploaded `.igc` file)

# external resources
## DEM files:

https://github.com/tilezen/joerd/issues

## Map tiles

https://tile.openstreetmap.org/
