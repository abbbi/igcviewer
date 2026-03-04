package igc

import (
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

