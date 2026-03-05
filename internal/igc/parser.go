package igc

import (
	"bufio"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Fix is one position record in an IGC track (B record).
type Fix struct {
	Time            time.Time `json:"time"`
	Latitude        float64   `json:"latitude"`
	Longitude       float64   `json:"longitude"`
	Validity        string    `json:"validity"`
	PressureAltM    int       `json:"pressureAltM"`
	GPSAltM         int       `json:"gpsAltM"`
	RecordLineIndex int       `json:"recordLineIndex"`
}

// Flight contains parsed metadata and fixes from an IGC file.
type Flight struct {
	Date     time.Time         `json:"date"`
	Headers  map[string]string `json:"headers"`
	Fixes    []Fix             `json:"fixes"`
	FixCount int               `json:"fixCount"`
	MaxClimb int               `json:"MaxClimb"`
	MaxAlt   int               `json:"MaxAlt"`
}

// Parse reads an IGC stream and returns structured data.
func Parse(r io.Reader) (*Flight, error) {
	scanner := bufio.NewScanner(r)
	flight := &Flight{
		Headers: make(map[string]string),
		Fixes:   make([]Fix, 0, 2048),
	}

	var (
		lineNum        int
		rolloverDays   int
		lastClock      = -1
		lastAltitude   = -1
		haveFlightDate bool
		climbRates     []int
		maxAlt         int
	)

	for scanner.Scan() {
		lineNum++
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		switch line[0] {
		case 'H':
			if d, ok := parseDateHeader(line); ok {
				flight.Date = d
				haveFlightDate = true
			}
			parseGenericHeader(line, flight.Headers)
		case 'B':
			fix, clockSec, err := parseBRecord(line, lineNum)
			if err != nil {
				return nil, fmt.Errorf("line %d: %w", lineNum, err)
			}

			if lastClock >= 0 && clockSec < lastClock {
				rolloverDays++
			}
			lastClock = clockSec

			if lastAltitude > fix.GPSAltM {
				curClimbRate := lastAltitude - fix.GPSAltM
				climbRates = append(climbRates, curClimbRate)
			}

			lastAltitude = fix.GPSAltM
			if fix.GPSAltM > maxAlt {
				maxAlt = fix.GPSAltM
			}

			if haveFlightDate {
				fix.Time = flight.Date.Add(time.Duration(rolloverDays)*24*time.Hour +
					time.Duration(clockSec)*time.Second)
			}
			flight.Fixes = append(flight.Fixes, fix)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	slices.Sort(climbRates)
	flight.MaxClimb = climbRates[len(climbRates)-1]
	flight.FixCount = len(flight.Fixes)
	flight.MaxAlt = maxAlt
	if flight.FixCount == 0 {
		return nil, fmt.Errorf("no B records found")
	}
	return flight, nil
}

func parseDateHeader(line string) (time.Time, bool) {
	// Format: HFDTEddmmyy
	idx := strings.Index(line, "HFDTE")
	if idx < 0 || len(line) < idx+11 {
		return time.Time{}, false
	}
	raw := line[idx+5 : idx+11]
	day, err1 := strconv.Atoi(raw[0:2])
	month, err2 := strconv.Atoi(raw[2:4])
	year2, err3 := strconv.Atoi(raw[4:6])
	if err1 != nil || err2 != nil || err3 != nil {
		return time.Time{}, false
	}
	year := 2000 + year2
	if year2 >= 80 {
		year = 1900 + year2
	}
	d := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	return d, true
}

func parseGenericHeader(line string, headers map[string]string) {
	if len(line) < 2 {
		return
	}
	body := line[1:]
	sep := strings.Index(body, ":")
	if sep < 0 {
		return
	}
	key := strings.TrimSpace(body[:sep])
	value := strings.TrimSpace(body[sep+1:])
	if key != "" {
		headers[key] = value
	}
}

func parseBRecord(line string, lineNum int) (Fix, int, error) {
	// BHHMMSSDDMMmmmNDDDMMmmmEVPPPPPggggg
	// Minimum required up to GPS altitude is 35 chars.
	if len(line) < 35 {
		return Fix{}, 0, fmt.Errorf("short B record")
	}
	if line[0] != 'B' {
		return Fix{}, 0, fmt.Errorf("invalid B record")
	}

	hh, err := strconv.Atoi(line[1:3])
	if err != nil {
		return Fix{}, 0, fmt.Errorf("invalid hour")
	}
	mm, err := strconv.Atoi(line[3:5])
	if err != nil {
		return Fix{}, 0, fmt.Errorf("invalid minute")
	}
	ss, err := strconv.Atoi(line[5:7])
	if err != nil {
		return Fix{}, 0, fmt.Errorf("invalid second")
	}
	if hh > 23 || mm > 59 || ss > 59 {
		return Fix{}, 0, fmt.Errorf("invalid time %02d:%02d:%02d", hh, mm, ss)
	}
	clockSec := hh*3600 + mm*60 + ss

	lat, err := parseLat(line[7:14], line[14])
	if err != nil {
		return Fix{}, 0, fmt.Errorf("invalid latitude: %w", err)
	}
	lon, err := parseLon(line[15:23], line[23])
	if err != nil {
		return Fix{}, 0, fmt.Errorf("invalid longitude: %w", err)
	}

	validity := string(line[24])
	pressAlt, err := strconv.Atoi(strings.TrimSpace(line[25:30]))
	if err != nil {
		return Fix{}, 0, fmt.Errorf("invalid pressure altitude")
	}
	gpsAlt, err := strconv.Atoi(strings.TrimSpace(line[30:35]))
	if err != nil {
		return Fix{}, 0, fmt.Errorf("invalid gps altitude")
	}

	return Fix{
		Latitude:        lat,
		Longitude:       lon,
		Validity:        validity,
		PressureAltM:    pressAlt,
		GPSAltM:         gpsAlt,
		RecordLineIndex: lineNum,
	}, clockSec, nil
}

func parseLat(raw string, hemi byte) (float64, error) {
	if len(raw) != 7 {
		return 0, fmt.Errorf("expected 7 digits")
	}
	deg, err := strconv.Atoi(raw[0:2])
	if err != nil {
		return 0, err
	}
	minmm, err := strconv.Atoi(raw[2:7])
	if err != nil {
		return 0, err
	}
	val := float64(deg) + float64(minmm)/60000.0
	if hemi == 'S' {
		val = -val
	} else if hemi != 'N' {
		return 0, fmt.Errorf("invalid hemisphere %q", hemi)
	}
	return val, nil
}

func parseLon(raw string, hemi byte) (float64, error) {
	if len(raw) != 8 {
		return 0, fmt.Errorf("expected 8 digits")
	}
	deg, err := strconv.Atoi(raw[0:3])
	if err != nil {
		return 0, err
	}
	minmm, err := strconv.Atoi(raw[3:8])
	if err != nil {
		return 0, err
	}
	val := float64(deg) + float64(minmm)/60000.0
	if hemi == 'W' {
		val = -val
	} else if hemi != 'E' {
		return 0, fmt.Errorf("invalid hemisphere %q", hemi)
	}
	return val, nil
}
