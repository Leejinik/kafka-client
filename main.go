package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

// Version is injected at build time via -ldflags "-X main.Version=v1.2.3".
// Local `wails build` without ldflags leaves this as "dev", which the updater
// treats as "do not nag for updates".
var Version = "dev"

func main() {
	// Create an instance of the app structure
	app := NewApp()
	app.version = Version

	// Create application with options
	err := wails.Run(&options.App{
		Title:  "Kafka Client",
		Width:  1280,
		Height: 820,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
