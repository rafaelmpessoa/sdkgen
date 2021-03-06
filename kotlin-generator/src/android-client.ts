import { AstRoot } from "@sdkgen/parser";
import { generateClass, generateEnum, generateErrorClass, generateJsonAddRepresentation, generateKotlinTypeName, mangle } from "./helpers";

interface Options {}

export function generateAndroidClientSource(ast: AstRoot, options: Options) {
    let code = `@file:Suppress("UNNECESSARY_SAFE_CALL")

import android.os.Parcelable
import kotlinx.android.parcel.Parcelize
import android.content.Context
import android.util.Base64
import com.google.gson.*
import com.google.gson.reflect.TypeToken
import com.google.gson.annotations.JsonAdapter
import io.sdkgen.runtime.SdkgenHttpClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers.IO
import kotlinx.coroutines.async
import kotlinx.coroutines.Dispatchers.Main
import kotlinx.coroutines.launch
import java.util.*

inline fun <reified T> Gson.fromJson(json: String) =
    fromJson<T>(json, object : TypeToken<T>() {}.type)

inline fun <reified T> Gson.fromJson(json: JsonElement) =
    fromJson<T>(json, object : TypeToken<T>() {}.type)

@Suppress("DeferredIsResult", "unused")
class ApiClient(
    baseUrl: String,
    applicationContext: Context,
    defaultTimeoutMillis: Long = 10000L
) : SdkgenHttpClient(baseUrl, applicationContext, defaultTimeoutMillis) {
    
    private val gson = GsonBuilder()
        .registerTypeAdapter(object : TypeToken<ByteArray>() {}.type, ByteArrayDeserializer())
        .create()\n\n`;

    for (const type of ast.enumTypes) {
        code += `   ${generateEnum(type)}`;
        code += "\n";
    }

    code += `    open class Error(val message: String? = null)\n`;
    code += `    data class Response<T>(val error: Error?, val data: T?)\n\n`;

    for (const type of ast.structTypes) {
        code += `    ${generateClass(type)}\n`;
    }

    const errorTypeEnumEntries: string[] = [];

    const connectionError = "Connection";
    errorTypeEnumEntries.push(connectionError);
    code += `    ${generateErrorClass(connectionError)}`;

    for (const error of ast.errors) {
        code += `    ${generateErrorClass(error)}`;
        errorTypeEnumEntries.push(error);
    }

    if (errorTypeEnumEntries.length > 0) {
        code += `
    enum class ErrorType {
        ${errorTypeEnumEntries.join(",\n        ")};

        fun type(): Class<out ApiClient.Error> {
            return when (this) {
                ${errorTypeEnumEntries.map(error => `${error} -> ApiClient.${error}::class.java`).join("\n                ")}
                else -> ApiClient.Error::class.java
            }
        }
    }\n\n`;
    }

    code += `    private val sdkgenIOScope = CoroutineScope(IO)\n`;
    code += `    private val uiScope = CoroutineScope(Main)\n\n`;
    code += ast.operations
        .map(op => {
            let opImpl = "";
            let args = op.args
                .map(arg => `${mangle(arg.name)}: ${generateKotlinTypeName(arg.type)}`)
                .concat([
                    `timeoutMillis: Long? = null`,
                    `callback: ((response: Response<${generateKotlinTypeName(op.returnType)}>) -> Unit)? = null`,
                ]);
            opImpl += `    fun ${mangle(op.prettyName)}(\n        ${args.join(",\n        ")}\n    ): Deferred<Response<out ${generateKotlinTypeName(
                op.returnType,
            )}>> = sdkgenIOScope.async {\n`;

            if (op.args.length > 0) {
                opImpl += `        val bodyArgs = JsonObject().apply {\n`;
                opImpl += op.args.map(arg => `            ${generateJsonAddRepresentation(arg.type, arg.name)}`).join("\n");
                opImpl += `\n        }\n`;
            } else {
                opImpl += `        val bodyArgs: JsonObject? = null`;
            }

            opImpl += `\n`;
            opImpl += `        val call = makeRequest(\"${op.prettyName}\", bodyArgs, timeoutMillis)\n`;
            opImpl += `        val response: Response<${generateKotlinTypeName(op.returnType)}> = handleCallResponse(call)\n`;
            opImpl += `        uiScope.launch { callback?.invoke(response) } \n`;
            opImpl += `        return@async response\n`;
            opImpl += `    }\n`;
            return opImpl;
        })
        .join("\n");

    code += `
    private inline fun <reified T> handleCallResponse(callResponse: InternalResponse): Response<T> {
        val data = if (callResponse.result?.get("result") != null)
            gson.fromJson<T>(callResponse.result?.get("result")!!)
        else null

        val error = if (callResponse.error != null) {
            val errorType = try {
                ErrorType.valueOf(callResponse.error?.get("type")?.asString ?: "")
            } catch (e: Exception) {
                ErrorType.Fatal
            }

            gson.fromJson(callResponse.error, errorType.type())
        } else null

        return Response(error, data)
    }
    `;

    code += `}\n`;

    return code;
}
