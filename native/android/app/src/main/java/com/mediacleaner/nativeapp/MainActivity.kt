package com.mediacleaner.nativeapp

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.mediacleaner.nativeapp.ui.MediaCleanerTheme
import com.mediacleaner.nativeapp.ui.RootScreen
import com.mediacleaner.nativeapp.ui.AppState
import androidx.lifecycle.viewmodel.compose.viewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val state: AppState = viewModel()
            MediaCleanerTheme(theme = state.theme) {
                RootScreen(state)
            }
        }
    }
}
