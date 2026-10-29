/**
 * WebP/JPEG 帧解码 Worker，减轻控制页主线程压力
 */
self.onmessage = async (event) => {
    const { id, blob, resizeWidth } = event.data || {};
    if (id == null || !blob) return;
    try {
        let bitmap;
        if (resizeWidth && resizeWidth > 0) {
            try {
                bitmap = await createImageBitmap(blob, {
                    resizeWidth,
                    resizeQuality: "low",
                });
            } catch (_) {
                bitmap = await createImageBitmap(blob);
            }
        } else {
            bitmap = await createImageBitmap(blob);
        }
        self.postMessage({ id, bitmap }, [bitmap]);
    } catch (e) {
        self.postMessage({ id, error: String(e && e.message ? e.message : e) });
    }
};
