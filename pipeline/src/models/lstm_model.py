"""
models/lstm_model.py — LSTM Sequence Model
==========================================
Why LSTM for trading:
  - Captures temporal dependencies (patterns across 50+ candles)
  - Handles the sequence nature of market data
  - Better for regime detection and trend continuation
  - Complements XGBoost (ensemble later)

Architecture:
  Input: (batch, seq_len=50, n_features=30)
    ↓
  LSTM(128, return_sequences=True)
    ↓
  Dropout(0.3)
    ↓
  LSTM(64)
    ↓
  Dropout(0.2)
    ↓
  BatchNorm
    ↓
  Dense(32, ReLU)
    ↓
  Dense(3, Softmax)  ← [P(SELL), P(HOLD), P(BUY)]

Training strategy:
  - Sequence length: 50 bars (look back 50 candles)
  - Batch size: 256 (large batch for stable LSTM gradients)
  - Optimizer: Adam with cosine annealing LR schedule
  - Early stopping: 15 epochs patience on val_loss
  - Class weights: inverse-frequency

Framework: TensorFlow/Keras (or PyTorch fallback)
"""
import numpy as np
import json
import pickle
from pathlib import Path
from typing import Optional

from src.models.base_model import BaseModel, TrainResult, FEATURE_COLS
from src.utils.logger import get_logger

logger = get_logger("LSTMModel")

SEQ_LEN    = 50    # lookback window
BATCH_SIZE = 256
MAX_EPOCHS = 100


class LSTMModel(BaseModel):
    """
    LSTM-based sequence classifier for BUY/HOLD/SELL prediction.
    Requires tensorflow>=2.15 or torch>=2.1.
    """

    name = "lstm"

    def __init__(
        self,
        symbol:    str,
        timeframe: str,
        seq_len:   int = SEQ_LEN,
        framework: str = "tensorflow",   # "tensorflow" or "torch"
    ):
        super().__init__(symbol, timeframe)
        self.seq_len   = seq_len
        self.framework = framework
        self._scaler   = None
        self._history  = None

    # ─── Train ───────────────────────────────────────────────────────────────

    def train(
        self,
        X_train: np.ndarray, y_train: np.ndarray,
        X_val:   np.ndarray, y_val:   np.ndarray,
    ) -> TrainResult:
        logger.info(
            f"[{self.symbol}/{self.timeframe}] Training LSTM "
            f"(seq={self.seq_len}, train={len(X_train):,})"
        )

        # Normalize
        from sklearn.preprocessing import RobustScaler
        self._scaler = RobustScaler()
        X_train_s    = self._scaler.fit_transform(X_train)
        X_val_s      = self._scaler.transform(X_val)

        # Build sequences
        Xs_train, ys_train = self._make_sequences(X_train_s, y_train)
        Xs_val,   ys_val   = self._make_sequences(X_val_s,   y_val)

        if len(Xs_train) < 100:
            raise ValueError(
                f"Too few sequences ({len(Xs_train)}) — "
                f"need at least {self.seq_len + 100} samples"
            )

        logger.info(
            f"  Sequences: train={Xs_train.shape} val={Xs_val.shape}"
        )

        if self.framework == "tensorflow":
            result = self._train_tf(Xs_train, ys_train, Xs_val, ys_val, y_val)
        else:
            result = self._train_torch(Xs_train, ys_train, Xs_val, ys_val, y_val)

        return result

    # ─── TensorFlow / Keras ───────────────────────────────────────────────────

    def _train_tf(
        self,
        Xs_train: np.ndarray, ys_train: np.ndarray,
        Xs_val:   np.ndarray, ys_val:   np.ndarray,
        y_val_orig: np.ndarray,
    ) -> TrainResult:
        try:
            import tensorflow as tf
            from tensorflow import keras
        except ImportError:
            raise ImportError("pip install tensorflow>=2.15")

        tf.random.set_seed(42)
        n_features = Xs_train.shape[2]

        # Class weights
        cw = self._class_weights(ys_train.argmax(axis=1))

        # ── Model architecture ─────────────────────────────────────────────
        model = keras.Sequential([
            keras.layers.Input(shape=(self.seq_len, n_features)),

            keras.layers.LSTM(128, return_sequences=True,
                              kernel_regularizer=keras.regularizers.l2(1e-4)),
            keras.layers.Dropout(0.30),

            keras.layers.LSTM(64, return_sequences=False,
                              kernel_regularizer=keras.regularizers.l2(1e-4)),
            keras.layers.Dropout(0.20),

            keras.layers.BatchNormalization(),
            keras.layers.Dense(32, activation="relu"),
            keras.layers.Dropout(0.10),

            keras.layers.Dense(3, activation="softmax"),
        ], name=f"lstm_{self.symbol}_{self.timeframe}")

        model.summary(print_fn=logger.debug)

        # ── Optimizer + LR schedule ────────────────────────────────────────
        lr_schedule = keras.optimizers.schedules.CosineDecayRestarts(
            initial_learning_rate = 1e-3,
            first_decay_steps     = 500,
            t_mul                 = 2.0,
            m_mul                 = 0.9,
        )
        model.compile(
            optimizer = keras.optimizers.Adam(lr_schedule),
            loss      = "categorical_crossentropy",
            metrics   = ["accuracy"],
        )

        # ── Callbacks ──────────────────────────────────────────────────────
        callbacks = [
            keras.callbacks.EarlyStopping(
                monitor              = "val_loss",
                patience             = 15,
                restore_best_weights = True,
                verbose              = 1,
            ),
            keras.callbacks.ReduceLROnPlateau(
                monitor  = "val_loss",
                factor   = 0.5,
                patience = 7,
                min_lr   = 1e-6,
                verbose  = 1,
            ),
        ]

        # ── Train ──────────────────────────────────────────────────────────
        history = model.fit(
            Xs_train, ys_train,
            validation_data = (Xs_val, ys_val),
            epochs          = MAX_EPOCHS,
            batch_size      = BATCH_SIZE,
            class_weight    = cw,
            callbacks       = callbacks,
            verbose         = 1,
        )

        self._model   = model
        self._history = history.history
        self._trained = True

        # Evaluate on original labels (not one-hot)
        proba   = model.predict(Xs_val, verbose=0)
        preds   = proba.argmax(axis=1) - 1   # back to -1,0,+1
        y_v_adj = y_val_orig[-len(preds):]
        metrics = self.evaluate(
            Xs_val, y_v_adj
        )

        best_epoch = int(np.argmin(history.history["val_loss"])) + 1
        logger.info(
            f"[{self.symbol}] LSTM done: acc={metrics['accuracy']:.3f} "
            f"best_epoch={best_epoch}/{MAX_EPOCHS}"
        )

        result = TrainResult(
            model_name    = self.name,
            symbol        = self.symbol,
            timeframe     = self.timeframe,
            train_samples = len(Xs_train),
            val_samples   = len(Xs_val),
            accuracy      = metrics["accuracy"],
            precision     = metrics["precision"],
            recall        = metrics["recall"],
            f1            = metrics["f1"],
            feature_importance = {},  # no direct feature importance in LSTM
            hyperparams   = {"seq_len": self.seq_len, "best_epoch": best_epoch},
        )

        path = self.save()
        result.model_path = str(path)
        self.save_meta(result)
        return result

    # ─── PyTorch alternative ──────────────────────────────────────────────────

    def _train_torch(
        self,
        Xs_train, ys_train, Xs_val, ys_val, y_val_orig
    ) -> TrainResult:
        """PyTorch LSTM training as alternative to TensorFlow."""
        try:
            import torch
            import torch.nn as nn
            from torch.utils.data import DataLoader, TensorDataset
        except ImportError:
            raise ImportError("pip install torch>=2.1")

        n_feat = Xs_train.shape[2]
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        logger.info(f"  PyTorch device: {device}")

        # Convert to tensors (one-hot → class indices for CrossEntropy)
        X_tr = torch.FloatTensor(Xs_train).to(device)
        y_tr = torch.LongTensor(ys_train.argmax(axis=1)).to(device)
        X_vl = torch.FloatTensor(Xs_val).to(device)
        y_vl = torch.LongTensor(ys_val.argmax(axis=1)).to(device)

        # ── Model ──────────────────────────────────────────────────────────
        class TradingLSTM(nn.Module):
            def __init__(self, n_features, seq_len):
                super().__init__()
                self.lstm1 = nn.LSTM(n_features, 128, batch_first=True, dropout=0.3)
                self.lstm2 = nn.LSTM(128, 64, batch_first=True)
                self.bn    = nn.BatchNorm1d(64)
                self.fc1   = nn.Linear(64, 32)
                self.fc2   = nn.Linear(32, 3)
                self.relu  = nn.ReLU()
                self.drop  = nn.Dropout(0.1)

            def forward(self, x):
                out, _ = self.lstm1(x)
                out, _ = self.lstm2(out)
                out    = out[:, -1, :]  # last timestep
                out    = self.bn(out)
                out    = self.relu(self.fc1(out))
                out    = self.drop(out)
                return self.fc2(out)

        model     = TradingLSTM(n_feat, self.seq_len).to(device)
        optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=50)
        criterion = nn.CrossEntropyLoss()

        loader = DataLoader(
            TensorDataset(X_tr, y_tr),
            batch_size=BATCH_SIZE, shuffle=True
        )

        best_val_loss = float("inf")
        patience_cnt  = 0
        best_state    = None

        for epoch in range(MAX_EPOCHS):
            model.train()
            for xb, yb in loader:
                optimizer.zero_grad()
                loss = criterion(model(xb), yb)
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()

            # Validation
            model.eval()
            with torch.no_grad():
                val_loss = criterion(model(X_vl), y_vl).item()

            scheduler.step()

            if val_loss < best_val_loss:
                best_val_loss = val_loss
                best_state    = {k: v.clone() for k, v in model.state_dict().items()}
                patience_cnt  = 0
            else:
                patience_cnt += 1
                if patience_cnt >= 15:
                    logger.info(f"  Early stop at epoch {epoch + 1}")
                    break

            if (epoch + 1) % 10 == 0:
                logger.info(f"  Epoch {epoch+1}: val_loss={val_loss:.4f}")

        model.load_state_dict(best_state)
        self._model   = model
        self._trained = True

        # Wrap for predict_proba compatibility
        self._torch_device = device

        metrics = self._eval_torch(model, X_vl, y_val_orig[-len(Xs_val):], device)
        result  = TrainResult(
            model_name="lstm_torch", symbol=self.symbol, timeframe=self.timeframe,
            train_samples=len(Xs_train), val_samples=len(Xs_val),
            accuracy=metrics["accuracy"], precision=metrics["precision"],
            recall=metrics["recall"], f1=metrics["f1"],
            feature_importance={}, hyperparams={"seq_len": self.seq_len},
        )
        self.save()
        self.save_meta(result)
        return result

    def _eval_torch(self, model, X_val, y_val, device):
        import torch
        import torch.nn.functional as F
        model.eval()
        with torch.no_grad():
            logits = model(X_val)
            proba  = F.softmax(logits, dim=1).cpu().numpy()
        preds  = proba.argmax(axis=1) - 1
        y_v    = y_val[-len(preds):]
        return self.evaluate(proba, y_v)

    # ─── Predict ─────────────────────────────────────────────────────────────

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        """
        X: (N, n_features) or (seq_len, n_features) for single prediction.
        Returns (1, 3) or (N, 3) probabilities.
        """
        if not self._trained and not self.load():
            raise RuntimeError("Model not trained")

        if self._scaler is not None:
            X = self._scaler.transform(X)

        # Build sequence from X: if too short, pad with zeros
        if X.shape[0] < self.seq_len:
            pad = np.zeros((self.seq_len - X.shape[0], X.shape[1]))
            X   = np.vstack([pad, X])

        # Use last seq_len rows as the sequence
        seq = X[-self.seq_len:][np.newaxis]  # (1, seq_len, n_feat)

        if self.framework == "tensorflow" and hasattr(self._model, "predict"):
            proba = self._model.predict(seq, verbose=0)
        elif hasattr(self, "_torch_device"):
            import torch
            import torch.nn.functional as F
            self._model.eval()
            with torch.no_grad():
                t     = torch.FloatTensor(seq).to(self._torch_device)
                proba = F.softmax(self._model(t), dim=1).cpu().numpy()
        else:
            raise RuntimeError("Unknown model state")

        return proba  # (1, 3): [P(SELL), P(HOLD), P(BUY)]

    # ─── Sequence builder ─────────────────────────────────────────────────────

    def _make_sequences(
        self, X: np.ndarray, y: np.ndarray
    ) -> tuple:
        """
        Build overlapping sequences of length seq_len.
        NO FUTURE LEAKAGE: label at position t uses y[t] (current bar).
        """
        n       = len(X)
        n_seq   = n - self.seq_len
        n_feat  = X.shape[1]

        Xs = np.zeros((n_seq, self.seq_len, n_feat), dtype="float32")
        ys = np.zeros((n_seq, 3), dtype="float32")  # one-hot

        for i in range(n_seq):
            Xs[i] = X[i: i + self.seq_len]
            label = int(y[i + self.seq_len - 1]) + 1  # -1→0, 0→1, +1→2
            ys[i, label] = 1.0

        return Xs, ys

    def _class_weights(self, y_idx: np.ndarray) -> dict:
        """Inverse-frequency class weights for Keras."""
        classes, counts = np.unique(y_idx, return_counts=True)
        n     = len(y_idx)
        total = len(classes)
        return {int(c): float(n / (total * cnt))
                for c, cnt in zip(classes, counts)}

    # ─── Save / Load ─────────────────────────────────────────────────────────

    def save(self) -> Path:
        scaler_path = self.model_dir / "scaler.pkl"

        if self._scaler is not None:
            with open(scaler_path, "wb") as f:
                pickle.dump(self._scaler, f, protocol=5)

        if self.framework == "tensorflow" and self._model is not None:
            model_path = self.model_dir / "model.keras"
            self._model.save(model_path)
        elif hasattr(self, "_torch_device"):
            import torch
            model_path = self.model_dir / "model.pt"
            torch.save(self._model.state_dict(), model_path)
        else:
            model_path = self.model_dir / "model.pkl"
            with open(model_path, "wb") as f:
                pickle.dump(self._model, f, protocol=5)

        logger.debug(f"[{self.symbol}] LSTM saved: {model_path}")
        return model_path

    def load(self) -> bool:
        scaler_path = self.model_dir / "scaler.pkl"
        if scaler_path.exists():
            with open(scaler_path, "rb") as f:
                self._scaler = pickle.load(f)

        keras_path = self.model_dir / "model.keras"
        torch_path = self.model_dir / "model.pt"

        if keras_path.exists():
            try:
                from tensorflow import keras
                self._model = keras.models.load_model(str(keras_path))
                self.framework = "tensorflow"
                if not self.validate_loaded_metadata():
                    logger.error(
                        f"Rejected LSTM artifact metadata/checksum mismatch for "
                        f"{self.symbol}/{self.timeframe}"
                    )
                    self._model = None
                    return False
                self._trained = True
                return True
            except Exception as e:
                self._model = None
                logger.error(f"Keras load failed: {e}")

        if torch_path.exists():
            logger.info("PyTorch model load requires model architecture — use save()/load() pair")
            return False

        return False
