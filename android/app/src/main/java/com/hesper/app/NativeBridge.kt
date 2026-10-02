package com.hesper.app

object NativeBridge {
    init { System.loadLibrary("hesper") }
    @JvmStatic external fun startServer(rootDir: String)
}
