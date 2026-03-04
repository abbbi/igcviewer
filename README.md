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

# External resources

For rendering the map, several external sources are used/loaded:

## DEM files:

https://github.com/tilezen/joerd/ (https://s3.amazonaws.com/elevation-tiles-prod/)

## Map tiles

https://tile.openstreetmap.org/

## Satellite raster

https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/
