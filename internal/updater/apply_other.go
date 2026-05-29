//go:build !windows

package updater

import "errors"

// applyPlatform is a stub for non-Windows platforms. The Mac/Linux side of
// kafka-client doesn't ship binaries via GitHub Releases (Wails refuses
// Windows→Mac cross-compile, so the macOS build is handed off as a source
// zip — see README-MAC.txt), so there's nothing to auto-apply.
func applyPlatform(exePath, newPath string) error {
	return errors.New("auto-update is not supported on this platform")
}
