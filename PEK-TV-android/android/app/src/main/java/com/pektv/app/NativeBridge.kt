package com.pektv.app

object NativeBridge {
    init { System.loadLibrary("pek") }
    @JvmStatic external fun startServer(rootDir: String)
    @JvmStatic external fun tlsDiag(): String   // temporary diagnostic
}
