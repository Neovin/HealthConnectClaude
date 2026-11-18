package com.healthconnectclaude.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.lifecycle.lifecycleScope
import androidx.work.WorkManager
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private companion object {
        /** Días de historial que se cargan (unos dos años). */
        const val HISTORY_DAYS = 731L
    }

    private lateinit var prefs: Prefs
    private lateinit var urlInput: EditText
    private lateinit var secretInput: EditText
    private lateinit var statusText: TextView
    private lateinit var historyText: TextView
    private lateinit var logText: TextView
    private lateinit var permissionLauncher: ActivityResultLauncher<Set<String>>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)

        permissionLauncher = registerForActivityResult(
            PermissionController.createRequestPermissionResultContract()
        ) { granted ->
            val bg = HealthReader.PERMISSION_BACKGROUND in granted
            val hist = HealthReader.PERMISSION_HISTORY in granted
            val missing = listOfNotNull(
                if (bg) null else "segundo plano",
                if (hist) null else "datos anteriores",
            )
            toast("Permisos concedidos: ${granted.size}" +
                if (missing.isEmpty()) "" else " (falta: ${missing.joinToString(", ")})")
            refresh()
        }

        setContentView(buildUi())
        if (prefs.isConfigured) {
            Syncer.schedulePeriodic(this)
            Syncer.resumeHistoryIfPending(this)
        }

        // Actualiza la pantalla cada vez que la carga del historial avanza.
        WorkManager.getInstance(this)
            .getWorkInfosForUniqueWorkLiveData(Syncer.HISTORY_WORK)
            .observe(this) { refresh() }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun buildUi(): View {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad * 2, pad, pad)
        }
        fun label(text: String, size: Float = 14f) = TextView(this).apply {
            this.text = text
            textSize = size
            setPadding(0, pad / 2, 0, pad / 4)
        }.also { root.addView(it) }
        fun button(text: String, onClick: () -> Unit) = Button(this).apply {
            this.text = text
            setOnClickListener { onClick() }
        }.also { root.addView(it) }

        label("Health Connect Claude", 22f)
        label("URL del servidor (p. ej. https://health-connect-mcp.tunombre.workers.dev)")
        urlInput = EditText(this).apply {
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(prefs.serverUrl)
            hint = "https://…workers.dev"
        }.also { root.addView(it) }
        label("Secreto de envío (API_SECRET configurado en el servidor)")
        secretInput = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setText(prefs.secret)
        }.also { root.addView(it) }

        button("1. Guardar ajustes") {
            prefs.serverUrl = urlInput.text.toString()
            prefs.secret = secretInput.text.toString()
            if (prefs.isConfigured) {
                Syncer.schedulePeriodic(this)
                toast("Guardado")
            } else {
                toast("La URL debe empezar por https:// y el secreto tener al menos 16 caracteres")
            }
            refresh()
        }
        button("2. Conceder permisos de Health Connect") { requestPermissions() }
        button("3. Sincronizar ahora") { runSync() }
        button("Cargar historial (2 años, en segundo plano)") {
            if (!prefs.isConfigured) return@button toast("Primero guarda los ajustes")
            val fresh = Syncer.startOrResumeHistory(this, HISTORY_DAYS)
            toast(
                if (fresh) "Carga iniciada. Puedes salir de la app: seguirá en segundo plano."
                else "Continuando la carga desde donde se quedó."
            )
            refresh()
        }
        button("Cancelar carga del historial") {
            Syncer.cancelHistory(this)
            refresh()
        }

        statusText = label("")
        historyText = label("")
        logText = label("", 12f)

        val scroll = ScrollView(this).apply { addView(root) }
        // Android 15+ dibuja la app a pantalla completa: deja sitio a la barra de estado, el notch y el teclado.
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
            )
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        return scroll
    }

    private fun requestPermissions() {
        when (HealthConnectClient.getSdkStatus(this)) {
            HealthConnectClient.SDK_AVAILABLE -> permissionLauncher.launch(HealthReader.ALL_PERMISSIONS)
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                toast("Actualiza Health Connect")
                startActivity(
                    Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.google.android.apps.healthdata"))
                )
            }
            else -> toast("Health Connect no está disponible en este dispositivo")
        }
    }

    private fun runSync() {
        if (!prefs.isConfigured) return toast("Primero guarda los ajustes")
        logText.text = ""
        statusText.text = "Sincronizando…"
        lifecycleScope.launch {
            val result = try {
                Syncer.sync(this@MainActivity) { line -> runOnUiThread { logText.append(line + "\n") } }
            } catch (e: Exception) {
                "Error: ${e.message}".also { prefs.lastStatus = it }
            }
            statusText.text = result
        }
    }

    private fun refresh() {
        if (!::statusText.isInitialized) return
        historyText.text = prefs.historyStatus
        lifecycleScope.launch {
            val permInfo = if (HealthConnectClient.getSdkStatus(this@MainActivity) == HealthConnectClient.SDK_AVAILABLE) {
                val granted = HealthConnectClient.getOrCreate(this@MainActivity).permissionController.getGrantedPermissions()
                val bg = if (HealthReader.PERMISSION_BACKGROUND in granted) "sí" else "no"
                val hist = if (HealthReader.PERMISSION_HISTORY in granted) "sí" else "no"
                "Permisos: ${granted.size}/${HealthReader.ALL_PERMISSIONS.size} · segundo plano: $bg · datos anteriores: $hist"
            } else {
                "Health Connect no disponible"
            }
            statusText.text = listOf(permInfo, prefs.lastStatus.ifEmpty { "Nunca sincronizado" }).joinToString("\n")
        }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
}

/** Pantalla informativa que muestra Health Connect cuando el usuario pregunta cómo se usan sus datos. */
class PrivacyActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (16 * resources.displayMetrics.density).toInt()
        setContentView(TextView(this).apply {
            setPadding(pad, pad * 2, pad, pad)
            textSize = 16f
            text = "Esta app lee tus datos de Health Connect en modo solo lectura y los envía " +
                "únicamente al servidor que has configurado tú (tu Cloudflare Worker), " +
                "para que puedas consultarlos desde Claude mediante un conector MCP personal. " +
                "No se comparte ningún dato con terceros."
        })
    }
}
