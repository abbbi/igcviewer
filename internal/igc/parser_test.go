package igc

import (
	"fmt"
	"math"
	"strings"
	"testing"
)

func TestParseBasic(t *testing.T) {
	const data = "" +
		"HFDTE020623\n" +
		"HFPLTPILOT: Test Pilot\n" +
		"B0811224739821N01147631EA0156701606\n" +
		"B0811234739823N01147627EA0156601604\n"

	flight, err := Parse(strings.NewReader(data))
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	if flight.FixCount != 2 {
		t.Fatalf("expected 2 fixes, got %d", flight.FixCount)
	}
	if got := flight.Headers["FPLTPILOT"]; got != "Test Pilot" {
		t.Fatalf("unexpected pilot header: %q", got)
	}
	if flight.Fixes[0].GPSAltM != 1606 {
		t.Fatalf("unexpected gps altitude: %d", flight.Fixes[0].GPSAltM)
	}
	if !flight.Fixes[1].Time.After(flight.Fixes[0].Time) {
		t.Fatalf("expected increasing timestamps")
	}
}

func TestParseMaxClimbUsesWindowedSmoothing(t *testing.T) {
	var b strings.Builder
	b.WriteString("HFDTE020623\n")

	for sec := 0; sec <= 24; sec++ {
		alt := 1000 + 4*sec
		// Inject a one-second spike (+7 m in 1 s), then return to baseline trend.
		if sec == 10 {
			alt += 3
		}

		line := fmt.Sprintf("B1200%02d4739821N01147631EA%05d%05d\n", sec, alt, alt)
		b.WriteString(line)
	}

	flight, err := Parse(strings.NewReader(b.String()))
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}

	const want = 4.0
	if math.Abs(flight.MaxClimb-want) > 0.001 {
		t.Fatalf("expected windowed max climb %.1f m/s, got %.3f", want, flight.MaxClimb)
	}
}
