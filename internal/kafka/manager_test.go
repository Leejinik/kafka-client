package kafka

import "testing"

func TestHostMatchesCN(t *testing.T) {
	cases := []struct {
		host, cn string
		want     bool
	}{
		{"kafka1.harrysingle.com", "kafka1.harrysingle.com", true},
		{"KAFKA1.harrysingle.com", "kafka1.harrysingle.COM", true}, // case-insensitive
		{"kafka1.harrysingle.com.", "kafka1.harrysingle.com", true}, // trailing dot
		{"kafka2.harrysingle.com", "kafka1.harrysingle.com", false},
		{"a.liz.com", "*.liz.com", true},          // wildcard, single label
		{"liz.com", "*.liz.com", false},           // wildcard needs a leftmost label
		{"a.b.liz.com", "*.liz.com", false},       // wildcard matches one label only
		{".liz.com", "*.liz.com", false},          // empty leftmost label must not match
		{"x.com", "*.com", false},                 // public-suffix wildcard rejected
		{"anything.com", "*.com", false},          // *.com must not match any single-label host
		{"kafka1.harrysingle.com", "", false},     // empty CN never matches
		{"", "kafka1.harrysingle.com", false},     // empty host never matches
		{"evil.com", "kafka1.harrysingle.com", false},
	}
	for _, c := range cases {
		if got := hostMatchesCN(c.host, c.cn); got != c.want {
			t.Errorf("hostMatchesCN(%q, %q) = %v, want %v", c.host, c.cn, got, c.want)
		}
	}
}

func TestBuildTLSConfigDisabled(t *testing.T) {
	got, err := buildTLSConfig(nil)
	if err != nil || got != nil {
		t.Fatalf("nil options: got (%v, %v), want (nil, nil)", got, err)
	}
	got, err = buildTLSConfig(&TLSOptions{Enabled: false, CACertPEM: "x"})
	if err != nil || got != nil {
		t.Fatalf("disabled: got (%v, %v), want (nil, nil)", got, err)
	}
}

func TestBuildTLSConfigBadCA(t *testing.T) {
	if _, err := buildTLSConfig(&TLSOptions{Enabled: true, CACertPEM: "not a pem"}); err == nil {
		t.Fatal("expected error for invalid CA PEM, got nil")
	}
}
