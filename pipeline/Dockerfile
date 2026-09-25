# Dockerfile — سيرفر الذكاء الاصطناعي (Python)
# ═══════════════════════════════════════════════════════════════════
# هذا الملف يُستخدم من طرف Back4App عندما تحدد "pipeline" كمجلد جذر
# (Root Directory) أثناء إعداد النشر.
# ═══════════════════════════════════════════════════════════════════

FROM python:3.12-slim

WORKDIR /app

# تثبيت مكتبات النظام المطلوبة (لبعض حزم Python العلمية)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# نسخ ملف المتطلبات أولاً (تحسين للـ cache)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# نسخ باقي ملفات المشروع
COPY . .

# إنشاء مجلدات البيانات المطلوبة
RUN mkdir -p data/raw data/clean data/features data/labels data/.tmp logs

# Back4App يمرر رقم المنفذ عبر متغير PORT تلقائياً
ENV PORT=5001
EXPOSE 5001

# فحص الصحة (Health Check) - يتأكد Back4App أن الخدمة تعمل
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://localhost:' + os.environ.get('PORT','5001') + '/health')" || exit 1

# تشغيل السيرفر - يستخدم متغير PORT من Back4App تلقائياً
# ملاحظة: --host غير مدعوم في run_all.py، لكن السيرفر مربوط داخلياً على 0.0.0.0 بشكل افتراضي
CMD python run_all.py serve --port ${PORT:-5001}
