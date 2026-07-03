// Package certutil parses PEM certificates so the UI can auto-fill broker
// hostnames from a cert and tell whether it's a CA (truststore) or a leaf
// (pin) certificate.
package certutil

import (
	"crypto/x509"
	"encoding/pem"
	"errors"
)

// Info summarizes a PEM cert (or bundle). The hostname fields come from the
// "primary" cert: the first leaf (non-CA) if present, else the first cert.
type Info struct {
	CommonName string   `json:"commonName"`
	DNSNames   []string `json:"dnsNames"`
	IPs        []string `json:"ips"`
	IsCA       bool     `json:"isCA"`       // BasicConstraints CA flag of the primary cert (often unreliable)
	SelfSigned bool     `json:"selfSigned"` // primary cert is self-signed (issuer == subject) → CA-like, not a broker leaf
	NotAfter   string   `json:"notAfter"`
	Count      int      `json:"count"`   // number of certs in the PEM
	HasCA      bool     `json:"hasCA"`   // bundle contains a self-signed (CA-like) cert
	HasLeaf    bool     `json:"hasLeaf"` // bundle contains a non-self-signed (leaf/broker) cert
}

// Parse decodes every CERTIFICATE block in pemStr and summarizes it.
func Parse(pemStr string) (Info, error) {
	rest := []byte(pemStr)
	var certs []*x509.Certificate
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		crt, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			continue
		}
		certs = append(certs, crt)
	}
	if len(certs) == 0 {
		return Info{}, errors.New("인증서를 파싱할 수 없습니다 (유효한 CERTIFICATE 블록 없음)")
	}

	// A broker end-entity (leaf) cert is one we can safely offer as a hostname:
	// it must NOT be self-signed (hand-rolled root CAs are, and lack the CA
	// flag) AND NOT be a CA (excludes intermediate/issuing CAs, which are
	// non-self-signed but still CAs). Everything else is treated as trust-only.
	selfSigned := func(c *x509.Certificate) bool { return c.Subject.String() == c.Issuer.String() }
	isLeaf := func(c *x509.Certificate) bool { return !selfSigned(c) && !c.IsCA }
	primary := certs[0]
	info := Info{Count: len(certs)}
	for _, c := range certs {
		if isLeaf(c) {
			info.HasLeaf = true
		} else {
			info.HasCA = true
		}
	}
	// Prefer the first real leaf as primary — its CN/SAN is the broker hostname.
	for _, c := range certs {
		if isLeaf(c) {
			primary = c
			break
		}
	}
	info.CommonName = primary.Subject.CommonName
	info.DNSNames = primary.DNSNames
	info.IsCA = primary.IsCA
	info.SelfSigned = selfSigned(primary)
	info.NotAfter = primary.NotAfter.Format("2006-01-02")
	for _, ip := range primary.IPAddresses {
		info.IPs = append(info.IPs, ip.String())
	}
	return info, nil
}
