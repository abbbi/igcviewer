/*
*

	Copyright (C) 2026  Michael Ablassmeier <abi@grinser.de>

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.

	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with this program.  If not, see <https://www.gnu.org/licenses/>.

*
*/
package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"igcp/internal/igc"
)

//go:embed web/*
var webFS embed.FS

type flightResponse struct {
	File      string            `json:"file"`
	Date      time.Time         `json:"date"`
	Headers   map[string]string `json:"headers"`
	FixCount  int               `json:"fixCount"`
	Bounds    [4]float64        `json:"bounds"`
	GeoJSON   any               `json:"geojson"`
	Samples   []trackSample     `json:"samples"`
	StartTime time.Time         `json:"startTime"`
	EndTime   time.Time         `json:"endTime"`
}

type trackSample struct {
	Lon  float64   `json:"lon"`
	Lat  float64   `json:"lat"`
	AltM int       `json:"altM"`
	Time time.Time `json:"time"`
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/flight", handleFlightUpload)
	mux.Handle("/", staticHandler())

	addr := "localhost:8080"
	log.Printf("Server listening on http://%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func handleFlightUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 20<<20)
	if err := r.ParseMultipartForm(20 << 20); err != nil {
		http.Error(w, "invalid upload form", http.StatusBadRequest)
		return
	}

	file, hdr, err := r.FormFile("igc")
	if err != nil {
		http.Error(w, "missing form file field 'igc'", http.StatusBadRequest)
		return
	}
	defer file.Close()

	name := strings.TrimSpace(hdr.Filename)
	if name == "" {
		name = "uploaded.igc"
	}
	if !strings.EqualFold(filepath.Ext(name), ".igc") {
		http.Error(w, "file extension must be .igc", http.StatusBadRequest)
		return
	}

	flight, err := igc.Parse(file)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	resp, err := buildResponse(name, flight)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, resp)
}

func staticHandler() http.Handler {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err)
	}
	return http.FileServer(http.FS(sub))
}

func buildResponse(name string, flight *igc.Flight) (*flightResponse, error) {
	if len(flight.Fixes) == 0 {
		return nil, fmt.Errorf("no fixes")
	}

	minLon := flight.Fixes[0].Longitude
	minLat := flight.Fixes[0].Latitude
	maxLon := minLon
	maxLat := minLat
	coords := make([][3]float64, 0, len(flight.Fixes))
	samples := make([]trackSample, 0, len(flight.Fixes))
	for _, fx := range flight.Fixes {
		if fx.Longitude < minLon {
			minLon = fx.Longitude
		}
		if fx.Longitude > maxLon {
			maxLon = fx.Longitude
		}
		if fx.Latitude < minLat {
			minLat = fx.Latitude
		}
		if fx.Latitude > maxLat {
			maxLat = fx.Latitude
		}
		coords = append(coords, [3]float64{fx.Longitude, fx.Latitude, float64(fx.GPSAltM)})
		samples = append(samples, trackSample{
			Lon:  fx.Longitude,
			Lat:  fx.Latitude,
			AltM: fx.GPSAltM,
			Time: fx.Time,
		})
	}

	feature := map[string]any{
		"type": "Feature",
		"properties": map[string]any{
			"file":     name,
			"fixCount": len(flight.Fixes),
		},
		"geometry": map[string]any{
			"type":        "LineString",
			"coordinates": coords,
		},
	}
	geojson := map[string]any{
		"type":     "FeatureCollection",
		"features": []any{feature},
	}

	resp := &flightResponse{
		File:      name,
		Date:      flight.Date,
		Headers:   flight.Headers,
		FixCount:  len(flight.Fixes),
		Bounds:    [4]float64{minLon, minLat, maxLon, maxLat},
		GeoJSON:   geojson,
		Samples:   samples,
		StartTime: flight.Fixes[0].Time,
		EndTime:   flight.Fixes[len(flight.Fixes)-1].Time,
	}
	return resp, nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}
