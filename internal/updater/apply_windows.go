//go:build windows

package updater

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// applyPlatform writes the cmd.exe swap helper next to the binary and spawns
// it detached. The helper loops until the running .exe releases its file
// lock, moves <new> over <current>, re-launches it, and self-deletes.
func applyPlatform(exePath, newPath string) error {
	helper := filepath.Join(filepath.Dir(exePath), "update.cmd")
	if err := os.WriteFile(helper, []byte(buildUpdateScript(exePath, newPath)), 0644); err != nil {
		return fmt.Errorf("write helper: %w", err)
	}
	cmd := exec.Command("cmd.exe", "/C", helper)
	// CREATE_NO_WINDOW only. Do NOT add DETACHED_PROCESS: the two flags are
	// mutually exclusive, and DETACHED_PROCESS *wins*, leaving the helper with
	// no console at all. Every external console command it then spawns in the
	// loop (`ping`) allocates its own brand-new console window — which flashes
	// up once per iteration (up to ~120 times) and looks like an endless cmd
	// flicker. CREATE_NO_WINDOW gives cmd a hidden console that `ping` inherits,
	// so nothing is shown. The helper still outlives us: on Windows a child is
	// not killed when the parent exits, and we Release() it below.
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000,
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("launch helper: %w", err)
	}
	_ = cmd.Process.Release()
	return nil
}

func buildUpdateScript(exePath, newPath string) string {
	// NOTE: do NOT use `timeout` for the delay. The helper runs detached with
	// no console (CREATE_NO_WINDOW) and redirected output, and `timeout`
	// requires a real console input handle — without one it errors out and
	// returns *instantly* (and on localized Windows spews "%d초 기다리는 중"),
	// turning :loop into a console-flooding busy-loop. `ping -n 2 127.0.0.1`
	// is the standard batch sleep that works headless and emits nothing.
	var sb strings.Builder
	sb.WriteString("@echo off\r\n")
	sb.WriteString("setlocal\r\n")
	sb.WriteString("set /a tries=0\r\n")
	sb.WriteString(":loop\r\n")
	sb.WriteString("ping -n 2 127.0.0.1 >nul 2>&1\r\n")
	sb.WriteString(fmt.Sprintf("move /Y \"%s\" \"%s\" >nul 2>&1\r\n", newPath, exePath))
	sb.WriteString("if not errorlevel 1 goto launch\r\n")
	// Give up after ~120 attempts (~2 min) so a permanently-locked file can't
	// loop forever. On giveup we skip the relaunch — the old exe is presumably
	// still running — and just clean up.
	sb.WriteString("set /a tries+=1\r\n")
	sb.WriteString("if %tries% lss 120 goto loop\r\n")
	sb.WriteString("goto cleanup\r\n")
	sb.WriteString(":launch\r\n")
	sb.WriteString(fmt.Sprintf("start \"\" \"%s\"\r\n", exePath))
	sb.WriteString(":cleanup\r\n")
	// Self-delete: jump past EOF, then delete this script.
	sb.WriteString("(goto) 2>nul & del \"%~f0\"\r\n")
	return sb.String()
}
