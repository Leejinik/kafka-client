// Package updater handles self-update for the Windows build.
//
// Flow:
//  1. Check() hits https://api.github.com/repos/<owner>/<repo>/releases/latest,
//     compares the tag with the build-time Version, and returns an UpdateInfo.
//  2. Apply() downloads the new .exe next to the current binary (<exe>.new),
//     writes a tiny update.cmd helper that waits for the running process to
//     exit, swaps the file, and re-launches it. Apply() returns; the caller is
//     responsible for quitting the Wails runtime so the helper can take over.
//  3. The release notes are persisted to ~/.kafka-client/pending-release-notes.json
//     before the swap. On the next startup the new binary reads that file and
//     shows the notes once, then deletes it.
package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	defaultOwner = "Leejinik"
	defaultRepo  = "kafka-client"
	defaultAsset = "kafka-client.exe"

	pendingNotesFile = "pending-release-notes.json"
)

// UpdateInfo is the result of a Check(). Available=false means "no update";
// the other fields may still be populated (e.g. CurrentVersion for display).
type UpdateInfo struct {
	Available      bool   `json:"available"`
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion"`
	ReleaseNotes   string `json:"releaseNotes"`
	DownloadURL    string `json:"downloadUrl"`
	PublishedAt    string `json:"publishedAt"`
}

// PendingNotes is the on-disk record of "show these release notes the next
// time the user runs version X".
type PendingNotes struct {
	Version string `json:"version"`
	Notes   string `json:"notes"`
}

type Updater struct {
	owner          string
	repo           string
	assetName      string
	currentVersion string
	configDir      string
	httpClient     *http.Client
}

// New builds an Updater. configDir is typically ~/.kafka-client.
func New(currentVersion, configDir string) *Updater {
	return &Updater{
		owner:          defaultOwner,
		repo:           defaultRepo,
		assetName:      defaultAsset,
		currentVersion: currentVersion,
		configDir:      configDir,
		httpClient:     &http.Client{Timeout: 15 * time.Second},
	}
}

func (u *Updater) CurrentVersion() string { return u.currentVersion }

type ghRelease struct {
	TagName     string    `json:"tag_name"`
	Body        string    `json:"body"`
	Draft       bool      `json:"draft"`
	Prerelease  bool      `json:"prerelease"`
	PublishedAt string    `json:"published_at"`
	Assets      []ghAsset `json:"assets"`
}
type ghAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// Check asks GitHub for the latest release and decides whether an update is
// available. Dev builds (Version == "" or "dev") never advertise updates.
func (u *Updater) Check(ctx context.Context) (UpdateInfo, error) {
	info := UpdateInfo{CurrentVersion: u.currentVersion}
	if u.currentVersion == "" || u.currentVersion == "dev" {
		return info, nil
	}
	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/releases/latest", u.owner, u.repo)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return info, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := u.httpClient.Do(req)
	if err != nil {
		return info, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		// No releases yet — treat as "no update".
		return info, nil
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return info, fmt.Errorf("github api %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	var rel ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return info, err
	}
	if rel.TagName == "" || rel.Draft {
		return info, nil
	}
	info.LatestVersion = rel.TagName
	info.ReleaseNotes = rel.Body
	info.PublishedAt = rel.PublishedAt
	for _, a := range rel.Assets {
		if a.Name == u.assetName {
			info.DownloadURL = a.BrowserDownloadURL
			break
		}
	}
	info.Available = compareSemver(rel.TagName, u.currentVersion) > 0 && info.DownloadURL != ""
	return info, nil
}

// compareSemver returns 1 if a > b, -1 if a < b, 0 if equal. Strips a leading
// 'v' and compares dot-separated parts numerically (falls back to string
// compare for non-numeric segments like "rc1").
func compareSemver(a, b string) int {
	pa := strings.Split(strings.TrimPrefix(a, "v"), ".")
	pb := strings.Split(strings.TrimPrefix(b, "v"), ".")
	n := len(pa)
	if len(pb) > n {
		n = len(pb)
	}
	for i := 0; i < n; i++ {
		var xa, xb string
		if i < len(pa) {
			xa = pa[i]
		}
		if i < len(pb) {
			xb = pb[i]
		}
		na, ea := strconv.Atoi(xa)
		nb, eb := strconv.Atoi(xb)
		if ea == nil && eb == nil {
			if na != nb {
				if na > nb {
					return 1
				}
				return -1
			}
			continue
		}
		if xa != xb {
			if xa > xb {
				return 1
			}
			return -1
		}
	}
	return 0
}

// Apply downloads the asset, stashes the release notes for the next launch,
// and hands off to the platform-specific swap helper (see updater_windows.go
// / updater_other.go). The caller must quit the process shortly after this
// returns so the helper can replace the binary.
func (u *Updater) Apply(ctx context.Context, info UpdateInfo) error {
	if !info.Available || info.DownloadURL == "" {
		return errors.New("no update available")
	}
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate exe: %w", err)
	}
	if resolved, err := filepath.EvalSymlinks(exePath); err == nil {
		exePath = resolved
	}
	newPath := exePath + ".new"

	if err := u.download(ctx, info.DownloadURL, newPath); err != nil {
		return fmt.Errorf("download: %w", err)
	}

	// Stash notes for the post-update launch. Non-fatal — proceed even if the
	// write fails; the worst case is the user doesn't get a notes popup.
	_ = u.SavePendingNotes(PendingNotes{Version: info.LatestVersion, Notes: info.ReleaseNotes})

	return applyPlatform(exePath, newPath)
}

func (u *Updater) download(ctx context.Context, url, dst string) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	// Big download — don't reuse the short-timeout client.
	cli := &http.Client{Timeout: 10 * time.Minute}
	resp, err := cli.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download status %d", resp.StatusCode)
	}
	tmp := dst + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	// Replace any stale .new from a previous attempt.
	_ = os.Remove(dst)
	return os.Rename(tmp, dst)
}

func (u *Updater) pendingPath() string {
	return filepath.Join(u.configDir, pendingNotesFile)
}

func (u *Updater) SavePendingNotes(p PendingNotes) error {
	if u.configDir == "" {
		return errors.New("no config dir")
	}
	if err := os.MkdirAll(u.configDir, 0755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(u.pendingPath(), b, 0644)
}

// LoadPendingNotes returns (notes, true, nil) iff a notes file exists for the
// CURRENT binary version. Notes left over for a different version are ignored
// (the update either didn't apply yet, or already shipped).
func (u *Updater) LoadPendingNotes() (PendingNotes, bool, error) {
	b, err := os.ReadFile(u.pendingPath())
	if errors.Is(err, os.ErrNotExist) {
		return PendingNotes{}, false, nil
	}
	if err != nil {
		return PendingNotes{}, false, err
	}
	var p PendingNotes
	if err := json.Unmarshal(b, &p); err != nil {
		return PendingNotes{}, false, err
	}
	if p.Version != u.currentVersion {
		return PendingNotes{}, false, nil
	}
	return p, true, nil
}

func (u *Updater) ClearPendingNotes() error {
	err := os.Remove(u.pendingPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
