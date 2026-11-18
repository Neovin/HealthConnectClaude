package com.healthconnectclaude.app

import android.content.Context
import android.content.SharedPreferences
import androidx.health.connect.client.HealthConnectClient
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit

class Prefs(context: Context) {
    private val p: SharedPreferences = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = p.getString("server_url", "") ?: ""
        set(v) = p.edit().putString("server_url", v.trim().trimEnd('/')).apply()

    var secret: String
        get() = p.getString("secret", "") ?: ""
        set(v) = p.edit().putString("secret", v.trim()).apply()

    /** Inicio de la última sincronización correcta (epoch ms), 0 si nunca. */
    var lastSyncMs: Long
        get() = p.getLong("last_sync_ms", 0L)
        set(v) = p.edit().putLong("last_sync_ms", v).apply()

    var lastStatus: String
        get() = p.getString("last_status", "") ?: ""
        set(v) = p.edit().putString("last_status", v).apply()

    /** Carga del historial: siguiente día pendiente (epoch day), -1 si no hay carga en curso. */
    var historyCursorDay: Long
        get() = p.getLong("history_cursor_day", -1L)
        set(v) = p.edit().putLong("history_cursor_day", v).apply()

    /** Carga del historial: día final (exclusivo, epoch day). */
    var historyEndDay: Long
        get() = p.getLong("history_end_day", -1L)
        set(v) = p.edit().putLong("history_end_day", v).apply()

    /** Carga del historial: registros enviados hasta ahora. */
    var historySent: Long
        get() = p.getLong("history_sent", 0L)
        set(v) = p.edit().putLong("history_sent", v).apply()

    var historyStatus: String
        get() = p.getString("history_status", "") ?: ""
        set(v) = p.edit().putString("history_status", v).apply()

    val isConfigured get() = serverUrl.startsWith("https://") && secret.length >= 16
    val historyActive get() = historyCursorDay >= 0 && historyCursorDay < historyEndDay
}

object Syncer {
    private val mutex = Mutex()
    private const val BATCH = 1000
    const val HISTORY_WORK = "health-history"
    private val TS = DateTimeFormatter.ofPattern("dd/MM HH:mm")

    /**
     * Sincronización normal. La primera vez lee los últimos 30 días;
     * después vuelve a leer desde 2 días antes de la última sincronización.
     */
    suspend fun sync(context: Context, log: (String) -> Unit = {}): String =
        mutex.withLock {
            withContext(Dispatchers.IO) { doSync(context, log) }
        }

    private suspend fun doSync(context: Context, log: (String) -> Unit): String {
        val prefs = Prefs(context)
        val (client, granted) = connect(context, prefs)

        val startedAt = Instant.now()
        val from = if (prefs.lastSyncMs > 0) {
            Instant.ofEpochMilli(prefs.lastSyncMs).minus(Duration.ofDays(2))
        } else {
            startedAt.minus(Duration.ofDays(30))
        }
        log("Leyendo desde ${DateTimeFormatter.ISO_LOCAL_DATE.format(from.atZone(ZoneId.systemDefault()))}…")

        val reader = HealthReader(client)
        val records = reader.readRawRecords(granted, from, startedAt, log) +
            reader.readDailySummaries(granted, from.atZone(ZoneId.systemDefault()).toLocalDate(), log)

        uploadAll(prefs, records, log)
        prefs.lastSyncMs = startedAt.toEpochMilli()
        val status = "OK ${TS.format(startedAt.atZone(ZoneId.systemDefault()))}: ${records.size} registros enviados"
        prefs.lastStatus = status
        return status
    }

    private suspend fun connect(context: Context, prefs: Prefs): Pair<HealthConnectClient, Set<String>> {
        if (!prefs.isConfigured) error("Primero configura la URL del servidor y el secreto")
        if (HealthConnectClient.getSdkStatus(context) != HealthConnectClient.SDK_AVAILABLE) {
            error("Health Connect no está disponible en este dispositivo")
        }
        val client = HealthConnectClient.getOrCreate(context)
        val granted = client.permissionController.getGrantedPermissions()
        if (granted.none { it.startsWith("android.permission.health.READ_") }) {
            error("No se ha concedido ningún permiso de Health Connect")
        }
        return client to granted
    }

    private fun uploadAll(prefs: Prefs, records: List<JSONObject>, log: (String) -> Unit) {
        var sent = 0
        for (chunk in records.chunked(BATCH)) {
            upload(prefs, chunk)
            sent += chunk.size
            log("Enviados $sent/${records.size}")
        }
    }

    private fun upload(prefs: Prefs, records: List<JSONObject>) {
        val body = JSONObject().put("records", JSONArray(records)).toString().toByteArray(Charsets.UTF_8)
        val conn = URL("${prefs.serverUrl}/ingest").openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 20_000
            conn.readTimeout = 60_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer ${prefs.secret}")
            conn.setFixedLengthStreamingMode(body.size)
            conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            if (code !in 200..299) {
                val err = conn.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
                error("El servidor respondió $code ${err.take(200)}")
            }
            conn.inputStream.use { it.readBytes() }
        } finally {
            conn.disconnect()
        }
    }

    fun schedulePeriodic(context: Context) {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(1, TimeUnit.HOURS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork("health-sync", ExistingPeriodicWorkPolicy.KEEP, request)
    }

    // ---------- Carga del historial, mes a mes y en segundo plano ----------

    /** Empieza (o reinicia) la carga de los últimos [days] días. */
    fun startHistory(context: Context, days: Long) {
        val prefs = Prefs(context)
        val today = LocalDate.now()
        prefs.historyCursorDay = today.minusDays(days).withDayOfMonth(1).toEpochDay()
        prefs.historyEndDay = today.plusDays(1).toEpochDay()
        prefs.historySent = 0
        prefs.historyStatus = "Historial: en cola…"
        enqueueHistory(context, ExistingWorkPolicy.REPLACE)
    }

    fun cancelHistory(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(HISTORY_WORK)
        val prefs = Prefs(context)
        prefs.historyCursorDay = -1
        prefs.historyStatus = "Historial: cancelado"
    }

    /** Si hay una carga a medias la continúa desde donde se quedó; si no, empieza una nueva. */
    fun startOrResumeHistory(context: Context, days: Long): Boolean {
        val prefs = Prefs(context)
        return if (prefs.historyActive) {
            prefs.historyStatus = "Historial: continuando…"
            enqueueHistory(context, ExistingWorkPolicy.KEEP)
            false
        } else {
            startHistory(context, days)
            true
        }
    }

    /** Reanuda una carga interrumpida (p. ej. tras reiniciar el móvil). */
    fun resumeHistoryIfPending(context: Context) {
        if (Prefs(context).historyActive) enqueueHistory(context, ExistingWorkPolicy.KEEP)
    }

    internal fun enqueueHistory(context: Context, policy: ExistingWorkPolicy) {
        val request = OneTimeWorkRequestBuilder<HistoryWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.LINEAR, 2, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(HISTORY_WORK, policy, request)
    }

    /**
     * Procesa meses del historial hasta agotar [budgetMs]. Cada mes se lee y se envía
     * por separado y el avance se guarda, así que una interrupción no pierde lo ya enviado.
     * Devuelve true si la carga ha terminado.
     */
    suspend fun runHistoryStep(context: Context, budgetMs: Long, progress: suspend (String) -> Unit): Boolean =
        withContext(Dispatchers.IO) {
            val prefs = Prefs(context)
            if (!prefs.historyActive) return@withContext true
            val (client, granted) = connect(context, prefs)
            val reader = HealthReader(client)
            val zone = ZoneId.systemDefault()
            val deadline = System.currentTimeMillis() + budgetMs

            while (prefs.historyActive && System.currentTimeMillis() < deadline) {
                val monthStart = LocalDate.ofEpochDay(prefs.historyCursorDay)
                val monthEnd = minOf(monthStart.withDayOfMonth(1).plusMonths(1), LocalDate.ofEpochDay(prefs.historyEndDay))
                val label = DateTimeFormatter.ofPattern("MM/yyyy").format(monthStart)
                prefs.historyStatus = "Historial: leyendo $label… (${prefs.historySent} registros enviados)"
                progress(prefs.historyStatus)

                val fromInstant = monthStart.atStartOfDay(zone).toInstant()
                val toInstant = monthEnd.atStartOfDay(zone).toInstant()
                val records = mutex.withLock {
                    reader.readRawRecords(granted, fromInstant, toInstant, {}, failFast = true) +
                        reader.readDailySummaries(granted, monthStart, {}, toDateExclusive = monthEnd, failFast = true)
                }
                uploadAll(prefs, records) {}

                prefs.historySent = prefs.historySent + records.size
                prefs.historyCursorDay = monthEnd.toEpochDay()
                prefs.historyStatus = "Historial: $label completado (${prefs.historySent} registros enviados)"
                progress(prefs.historyStatus)
            }

            val done = !prefs.historyActive
            if (done) {
                prefs.historyCursorDay = -1
                prefs.historyStatus = "Historial completo: ${prefs.historySent} registros enviados " +
                    "(${TS.format(Instant.now().atZone(zone))})"
                progress(prefs.historyStatus)
            }
            done
        }
}

/** Sincronización en segundo plano cada hora (requiere el permiso de acceso en segundo plano). */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = try {
        Syncer.sync(applicationContext)
        Result.success()
    } catch (e: CancellationException) {
        throw e
    } catch (e: SecurityException) {
        Prefs(applicationContext).lastStatus = "Segundo plano: falta un permiso (${e.message})"
        Result.failure()
    } catch (e: Exception) {
        Prefs(applicationContext).lastStatus = "Segundo plano: error ${e.message}"
        if (runAttemptCount < 3) Result.retry() else Result.failure()
    }
}

/**
 * Carga del historial. Cada ejecución trabaja unos minutos (WorkManager corta a los 10)
 * y, si queda trabajo, se vuelve a encolar a sí misma.
 */
class HistoryWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val prefs = Prefs(applicationContext)
        return try {
            val done = Syncer.runHistoryStep(applicationContext, budgetMs = 7 * 60_000L) { msg ->
                setProgress(workDataOf("status" to msg))
            }
            if (!done) Syncer.enqueueHistory(applicationContext, ExistingWorkPolicy.APPEND_OR_REPLACE)
            Result.success()
        } catch (e: CancellationException) {
            throw e
        } catch (e: SecurityException) {
            prefs.historyStatus = "Historial: falta un permiso (${e.message}). Revisa los permisos y vuelve a empezar."
            Result.failure()
        } catch (e: Exception) {
            if (runAttemptCount < 20) {
                prefs.historyStatus = "Historial: error (${e.message}). Reintentando en unos minutos…"
                Result.retry()
            } else {
                prefs.historyStatus = "Historial: detenido tras varios errores (${e.message}). Pulsa «Cargar historial» para continuar."
                Result.failure()
            }
        }
    }
}
