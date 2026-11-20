package com.healthconnectclaude.app

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.time.Instant

/**
 * Importación puntual del histórico de rutas GPS de Strava al servidor (POST /routes).
 * Se usa una vez y luego se puede quitar: las rutas nuevas las grabará la app Entreno.
 *
 * Importa las salidas en bici y las caminatas/senderismo de 8 km o más, a resolución completa.
 * Cada ruta se enlaza en el servidor con su sesión del reloj por la hora.
 */
object StravaImport {
    const val REDIRECT = "hcclaude://localhost/strava"
    private val BICI = setOf("Ride", "MountainBikeRide", "GravelRide", "EBikeRide", "EMountainBikeRide")
    private val ANDAR = setOf("Walk", "Hike")
    private const val MIN_ANDAR_M = 8000.0
    private const val MAX_PUNTOS = 20000

    private fun prefs(c: Context) = c.getSharedPreferences("strava_import", Context.MODE_PRIVATE)
    fun clientId(c: Context) = prefs(c).getString("client_id", "") ?: ""
    fun clientSecret(c: Context) = prefs(c).getString("client_secret", "") ?: ""
    fun guardar(c: Context, id: String, secreto: String) =
        prefs(c).edit().putString("client_id", id.trim()).putString("client_secret", secreto.trim()).apply()
    fun borrar(c: Context) = prefs(c).edit().clear().apply()

    fun urlPermiso(c: Context): String =
        "https://www.strava.com/oauth/authorize?client_id=${enc(clientId(c))}" +
            "&redirect_uri=${enc(REDIRECT)}&response_type=code&approval_prompt=force&scope=activity:read_all"

    /** Código de autorización si la URI es la vuelta de Strava; null si no lo es. */
    fun codigoDe(uri: Uri?): String? =
        if (uri != null && uri.scheme == "hcclaude" && uri.path == "/strava") uri.getQueryParameter("code") else null

    suspend fun importar(context: Context, code: String, log: (String) -> Unit): String = withContext(Dispatchers.IO) {
        val server = Prefs(context)
        if (!server.isConfigured) error("Primero guarda la URL del servidor y el secreto")

        log("Pidiendo permiso a Strava…")
        val token = postForm(
            "https://www.strava.com/oauth/token",
            mapOf("client_id" to clientId(context), "client_secret" to clientSecret(context), "code" to code, "grant_type" to "authorization_code"),
        ).getString("access_token")

        log("Leyendo la lista de actividades…")
        val todas = mutableListOf<JSONObject>()
        var page = 1
        while (true) {
            val arr = JSONArray(get("https://www.strava.com/api/v3/athlete/activities?per_page=200&page=$page", token))
            for (i in 0 until arr.length()) todas += arr.getJSONObject(i)
            if (arr.length() < 200) break
            page++
        }
        // OHealth a veces sube la misma actividad dos veces: se queda una por hora de inicio y distancia
        val elegidas = todas
            .filter { a ->
                val t = a.optString("sport_type", a.optString("type"))
                t in BICI || (t in ANDAR && a.optDouble("distance", 0.0) >= MIN_ANDAR_M)
            }
            .filter { it.optJSONObject("map")?.optString("summary_polyline").orEmpty().isNotEmpty() }
            .distinctBy { it.getString("start_date") + "|" + Math.round(it.optDouble("distance", 0.0)) }
        log("${todas.size} actividades en Strava; ${elegidas.size} rutas para importar.")

        var ok = 0
        var enlazadas = 0
        for ((n, a) in elegidas.withIndex()) {
            val id = a.getLong("id")
            val tipo = a.optString("sport_type", a.optString("type"))
            val s = JSONObject(get("https://www.strava.com/api/v3/activities/$id/streams?keys=latlng,altitude,time&key_by_type=true", token))
            val ll = s.optJSONObject("latlng")?.optJSONArray("data") ?: JSONArray()
            val alt = s.optJSONObject("altitude")?.optJSONArray("data")
            val tim = s.optJSONObject("time")?.optJSONArray("data")
            if (ll.length() < 2) { log("· ${a.optString("name")}: sin puntos GPS, se omite"); continue }
            val paso = maxOf(1, (ll.length() + MAX_PUNTOS - 1) / MAX_PUNTOS)
            val indices = (0 until ll.length() step paso).toMutableList()
            if (indices.last() != ll.length() - 1) indices += ll.length() - 1
            val puntos = JSONArray()
            for (i in indices) {
                val p = ll.getJSONArray(i)
                val fila = JSONArray().put(tim?.optInt(i, 0) ?: 0).put(p.getDouble(0)).put(p.getDouble(1))
                if (alt != null && i < alt.length()) fila.put(alt.getDouble(i))
                puntos.put(fila)
            }
            val inicio = Instant.parse(a.getString("start_date"))
            val ruta = JSONObject()
                .put("id", "strava:$id")
                .put("start", inicio.toString())
                .put("end", inicio.plusSeconds(a.optLong("elapsed_time", 0)).toString())
                .put("date", a.getString("start_date_local").substring(0, 10))
                .put("activity", if (tipo in BICI) "biking" else if (tipo == "Hike") "hiking" else "walking")
                .put("source", "strava")
                .put("name", a.optString("name"))
                .put("distance_m", a.optDouble("distance", 0.0))
                .put("elevation_gain_m", a.optDouble("total_elevation_gain", 0.0))
                .put("points", puntos)
            val r = postJson("${server.serverUrl}/routes", server.secret, JSONObject().put("routes", JSONArray().put(ruta)))
            ok += r.optInt("upserted", 0)
            enlazadas += r.optInt("linked", 0)
            log("${n + 1}/${elegidas.size} ${ruta.getString("date")} ${a.optString("name")}: ${puntos.length()} puntos" +
                if (r.optInt("linked", 0) > 0) " · enlazada al reloj" else " · sin sesión del reloj")
        }
        "Importadas $ok rutas ($enlazadas enlazadas a su actividad del reloj)."
    }

    // ----------------------------------------------------------------- HTTP

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun leer(conn: HttpURLConnection): String {
        val code = conn.responseCode
        val txt = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        if (code == 429) error("Strava limita las consultas: espera 15 minutos y vuelve a intentarlo")
        if (code !in 200..299) error("HTTP $code: ${txt.take(200)}")
        return txt
    }

    private fun get(url: String, token: String): String {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 20_000; c.readTimeout = 60_000
            c.setRequestProperty("Authorization", "Bearer $token")
            return leer(c)
        } finally { c.disconnect() }
    }

    private fun postForm(url: String, campos: Map<String, String>): JSONObject {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 20_000; c.readTimeout = 60_000
            c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            c.outputStream.use { it.write(campos.entries.joinToString("&") { (k, v) -> "${enc(k)}=${enc(v)}" }.toByteArray()) }
            return JSONObject(leer(c))
        } finally { c.disconnect() }
    }

    private fun postJson(url: String, secreto: String, body: JSONObject): JSONObject {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 20_000; c.readTimeout = 120_000
            c.setRequestProperty("Content-Type", "application/json")
            c.setRequestProperty("Authorization", "Bearer $secreto")
            c.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            return JSONObject(leer(c))
        } finally { c.disconnect() }
    }
}
