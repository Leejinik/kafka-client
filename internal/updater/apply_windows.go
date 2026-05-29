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
	// DETACHED_PROCESS | CREATE_NO_WINDOW — keep the helper alive after we
	// exit and don't pop a console window.
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x00000008 | 0x08000000,
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("launch helper: %w", err)
	}
	_ = cmd.Process.Release()
	return nil
}

func buildUpdateScript(exePath, newPath string) string {
	var sb strings.Builder
	sb.WriteString("@echo off\r\n")
	sb.WriteString("setlocal\r\n")
	sb.WriteString(":loop\r\n")
	sb.WriteString("timeout /t 1 /nobreak >nul 2>&1\r\n")
	sb.WriteString(fmt.Sprintf("move /Y \"%s\" \"%s\" >nul 2>&1\r\n", newPath, exePath))
	sb.WriteString("if errorlevel 1 goto loop\r\n")
	sb.WriteString(fmt.Sprintf("start \"\" \"%s\"\r\n", exePath))
	// Self-delete: jump past EOF, then delete this script.
	sb.WriteString("(goto) 2>nul & del \"%~f0\"\r\n")
	return sb.String()
}
