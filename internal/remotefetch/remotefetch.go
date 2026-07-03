// Package remotefetch pulls certificate files off a broker host over SSH so the
// user can point the SSL config at a remote CA cert without scp-ing it by hand.
// It runs two read-only remote commands: a filtered `find` to list cert files
// in a directory, and `cat` to read one. Password auth only; host keys are not
// pinned (InsecureIgnoreHostKey) — this is an internal admin convenience aimed
// at hosts the operator already owns.
package remotefetch

import (
	"context"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// maxCertBytes caps how much we read from a remote file. Certs/keys are tiny;
// this stops someone from accidentally cat-ing a huge or binary file into the
// textarea.
const maxCertBytes = 512 * 1024

func dial(ctx context.Context, host string, port int, user, password string) (*ssh.Client, error) {
	if strings.TrimSpace(host) == "" {
		return nil, fmt.Errorf("호스트를 입력하세요")
	}
	if strings.TrimSpace(user) == "" {
		return nil, fmt.Errorf("사용자를 입력하세요")
	}
	if port == 0 {
		port = 22
	}
	cfg := &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.Password(password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         10 * time.Second,
	}
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	// Dial with the context deadline so a hung TCP connect doesn't wedge the UI.
	d := net.Dialer{Timeout: 10 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("SSH 연결 실패(%s): %w", addr, err)
	}
	c, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("SSH 인증 실패: %w", err)
	}
	return ssh.NewClient(c, chans, reqs), nil
}

// run executes a single command and returns stdout. stderr is folded into the
// error on non-zero exit.
func run(client *ssh.Client, cmd string) (string, error) {
	sess, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer sess.Close()
	var stderr strings.Builder
	sess.Stderr = &stderr
	out, err := sess.Output(cmd)
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg != "" {
			return "", fmt.Errorf("%s", msg)
		}
		return "", err
	}
	return string(out), nil
}

// shq single-quotes a string for safe inclusion in a POSIX shell command.
func shq(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// Entry is one item in a remote directory listing.
type Entry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
}

// ListDir lists the entries directly under dir on the remote host, marking
// which are directories, so the UI can present an FTP-style browser. Entries
// are returned directories-first, each group sorted by name. "." and ".." are
// omitted (the UI synthesizes an "up" action).
func ListDir(ctx context.Context, host string, port int, user, password, dir string) ([]Entry, error) {
	if strings.TrimSpace(dir) == "" {
		dir = "."
	}
	client, err := dial(ctx, host, port, user, password)
	if err != nil {
		return nil, err
	}
	defer client.Close()

	// `ls -1Ap`: one per line, almost-all (no . / ..), and a trailing '/' on
	// directories. stderr is left unsuppressed so a bad path surfaces as an
	// error rather than a silently empty listing.
	out, err := run(client, "ls -1Ap "+shq(dir))
	if err != nil {
		return nil, err
	}
	var dirs, files []Entry
	for _, line := range strings.Split(out, "\n") {
		name := strings.TrimRight(line, "\r")
		if name == "" {
			continue
		}
		if strings.HasSuffix(name, "/") {
			dirs = append(dirs, Entry{Name: strings.TrimSuffix(name, "/"), IsDir: true})
		} else {
			files = append(files, Entry{Name: name, IsDir: false})
		}
	}
	sort.Slice(dirs, func(i, j int) bool { return dirs[i].Name < dirs[j].Name })
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	return append(dirs, files...), nil
}

// ReadFile cats a single remote file and returns its contents (capped).
func ReadFile(ctx context.Context, host string, port int, user, password, path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("파일 경로가 비어 있습니다")
	}
	client, err := dial(ctx, host, port, user, password)
	if err != nil {
		return "", err
	}
	defer client.Close()

	// head -c caps the payload; certs are far smaller than this.
	cmd := "head -c " + strconv.Itoa(maxCertBytes) + " " + shq(path)
	out, err := run(client, cmd)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(out) == "" {
		return "", fmt.Errorf("파일이 비어 있거나 읽을 수 없습니다: %s", path)
	}
	return out, nil
}
