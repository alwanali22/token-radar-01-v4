(function () {
  "use strict";

  // Categories where TVL is not the product: a chain, an exchange, a bridge,
  // a prediction market, a CeDeFi vault or a governance-incentives protocol
  // earns its footprint off-chain or off its own TVL, so its TVL understates
  // it. The list is explicit: a category not named here is not infra.
  var INFRA_CATEGORIES = {
    "Chain": true,
    "CEX": true,
    "Bridge": true,
    "Canonical Bridge": true,
    "Prediction Market": true,
    "CeDeFi": true,
    "Governance Incentives": true,
  };

  function isInfra(category) {
    return typeof category === "string" && INFRA_CATEGORIES[category] === true;
  }

  var FALLBACK_INTERCEPT = 3.3114;
  var FALLBACK_SLOPE = -0.5269;
  var FALLBACK_INFRA = 0.4686;
  var CLAMP_MIN = 0.02;
  var CLAMP_MAX = 0.8;

  function fallbackCurve(n) {
    return {
      intercept: FALLBACK_INTERCEPT,
      slope: FALLBACK_SLOPE,
      infra: FALLBACK_INFRA,
      n: n,
      clampMin: CLAMP_MIN,
      clampMax: CLAMP_MAX,
    };
  }

  // Fit log10(mcap / TVL) = a + b * log10(TVL) + c * [infra] by OLS on the
  // snapshot's live tokens. Same math as lib/model.ts fitValueModel: three
  // coefficients fitted at run time, solved through the 3x3 normal
  // equations with Gaussian elimination.
  function fitValueModel(liveProtocols) {
    var points = [];

    liveProtocols.forEach(function (protocol) {
      var tvl = protocol.tvl_usd;
      var mcap = protocol.mcap_usd;
      if (
        typeof tvl !== "number" ||
        typeof mcap !== "number" ||
        !Number.isFinite(tvl) ||
        !Number.isFinite(mcap) ||
        tvl <= 0 ||
        mcap <= 0
      ) {
        return;
      }
      points.push({
        x: Math.log10(tvl),
        z: isInfra(protocol.category) ? 1 : 0,
        y: Math.log10(mcap / tvl),
      });
    });

    var n = points.length;
    if (n < 10) {
      return fallbackCurve(n);
    }

    var ata = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    var aty = [0, 0, 0];
    var i;
    var j;
    points.forEach(function (point) {
      var row = [1, point.x, point.z];
      for (i = 0; i < 3; i += 1) {
        aty[i] += row[i] * point.y;
        for (j = 0; j < 3; j += 1) {
          ata[i][j] += row[i] * row[j];
        }
      }
    });

    var m = [
      [ata[0][0], ata[0][1], ata[0][2], aty[0]],
      [ata[1][0], ata[1][1], ata[1][2], aty[1]],
      [ata[2][0], ata[2][1], ata[2][2], aty[2]],
    ];
    var col;
    var r;
    var c;
    for (col = 0; col < 3; col += 1) {
      var pivot = col;
      for (r = col + 1; r < 3; r += 1) {
        if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) {
          pivot = r;
        }
      }
      if (Math.abs(m[pivot][col]) < 1e-12) {
        return fallbackCurve(n);
      }
      if (pivot !== col) {
        var tmp = m[col];
        m[col] = m[pivot];
        m[pivot] = tmp;
      }
      for (r = col + 1; r < 3; r += 1) {
        var factor = m[r][col] / m[col][col];
        for (c = col; c < 4; c += 1) {
          m[r][c] -= factor * m[col][c];
        }
      }
    }
    var beta = [0, 0, 0];
    for (r = 2; r >= 0; r -= 1) {
      var sum = m[r][3];
      for (c = r + 1; c < 3; c += 1) {
        sum -= m[r][c] * beta[c];
      }
      beta[r] = sum / m[r][r];
    }
    if (!beta.every(Number.isFinite)) {
      return fallbackCurve(n);
    }

    return {
      intercept: beta[0],
      slope: beta[1],
      infra: beta[2],
      n: n,
      clampMin: CLAMP_MIN,
      clampMax: CLAMP_MAX,
    };
  }

  // The plain two-term size curve, for the backtest comparison only: it is
  // the model without the infra term, fitted the same way.
  function fitSizeCurve(liveProtocols) {
    var points = [];

    liveProtocols.forEach(function (protocol) {
      var tvl = protocol.tvl_usd;
      var mcap = protocol.mcap_usd;
      if (
        typeof tvl !== "number" ||
        typeof mcap !== "number" ||
        !Number.isFinite(tvl) ||
        !Number.isFinite(mcap) ||
        tvl <= 0 ||
        mcap <= 0
      ) {
        return;
      }
      points.push({
        x: Math.log10(tvl),
        y: Math.log10(mcap / tvl),
      });
    });

    var n = points.length;
    if (n < 10) {
      return {
        intercept: 3.0247,
        slope: -0.4777,
        n: n,
        clampMin: 0.02,
        clampMax: 0.8,
      };
    }

    var meanX = points.reduce(function (sum, point) {
      return sum + point.x;
    }, 0) / n;
    var meanY = points.reduce(function (sum, point) {
      return sum + point.y;
    }, 0) / n;
    var covariance = 0;
    var varianceX = 0;

    points.forEach(function (point) {
      var dx = point.x - meanX;
      covariance += dx * (point.y - meanY);
      varianceX += dx * dx;
    });

    var slope = varianceX === 0 ? 0 : covariance / varianceX;
    return {
      intercept: meanY - slope * meanX,
      slope: slope,
      n: n,
      clampMin: 0.02,
      clampMax: 0.8,
    };
  }

  // The fitted multiple for one TVL, with the infra shift when the protocol
  // is infra. Clamp guards against implausibly tiny or huge fitted multiples.
  function fittedMultiple(tvl, infra, curve) {
    if (typeof tvl !== "number" || !Number.isFinite(tvl) || tvl <= 0) {
      return curve.clampMin;
    }
    var fitted = Math.pow(
      10,
      curve.intercept +
        curve.slope * Math.log10(tvl) +
        (infra ? curve.infra : 0)
    );
    return Math.min(curve.clampMax, Math.max(curve.clampMin, fitted));
  }

  // The plain size curve's multiple: the fitted multiple with no infra
  // shift. Delegates to fittedMultiple so the clamp lives in one place.
  function sizeMultiple(tvl, curve) {
    return fittedMultiple(tvl, false, curve);
  }

  // The implied value is the fitted live-comp value: TVL times the fitted
  // multiple, rounded to whole dollars. No haircut, no growth or maturity
  // multiplier. A row carries its infra flag; a bare protocol object falls
  // back to its category.
  function impliedValue(protocol, curve) {
    var tvl = Number.isFinite(protocol.tvl_usd) && protocol.tvl_usd > 0
      ? protocol.tvl_usd
      : 0;
    var infra = typeof protocol.infra === "boolean"
      ? protocol.infra
      : isInfra(protocol.category);
    return Math.max(
      1,
      Math.round(tvl * fittedMultiple(tvl, infra, curve))
    );
  }

  function medianOf(sorted) {
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // 5-fold cross-validation on the snapshot's live tokens: fold of point i
  // is i mod 5 (snapshot order), errors pooled across folds. Three models
  // compared on the same folds: the infra model, the plain size curve, and
  // a flat global median multiple, all in |log10 error|.
  function backtest(liveProtocols) {
    var usable = [];
    var i;
    var fold;

    for (i = 0; i < liveProtocols.length; i += 1) {
      var protocol = liveProtocols[i];
      if (
        !Number.isFinite(protocol.tvl_usd) ||
        protocol.tvl_usd <= 0 ||
        !Number.isFinite(protocol.mcap_usd) ||
        protocol.mcap_usd <= 0
      ) {
        continue;
      }
      usable.push(protocol);
    }

    var n = usable.length;
    if (n < 10) {
      return { infra: null, curve: null, flat: null, n: n };
    }

    var infraErrors = [];
    var curveErrors = [];
    var flatErrors = [];
    var actual;
    var predicted;

    for (fold = 0; fold < 5; fold += 1) {
      var training = [];
      var trainingLogs = [];

      for (i = 0; i < n; i += 1) {
        if (i % 5 !== fold) {
          training.push(usable[i]);
          trainingLogs.push(
            Math.log10(usable[i].mcap_usd / usable[i].tvl_usd)
          );
        }
      }

      trainingLogs.sort(function (a, b) {
        return a - b;
      });
      var flat = medianOf(trainingLogs);

      var foldInfra = fitValueModel(training);
      var foldCurve = fitSizeCurve(training);
      for (i = 0; i < n; i += 1) {
        if (i % 5 === fold) {
          actual = Math.log10(usable[i].mcap_usd / usable[i].tvl_usd);
          predicted = Math.log10(fittedMultiple(
            usable[i].tvl_usd,
            isInfra(usable[i].category),
            foldInfra
          ));
          infraErrors.push(Math.abs(predicted - actual));
          predicted = Math.log10(sizeMultiple(usable[i].tvl_usd, foldCurve));
          curveErrors.push(Math.abs(predicted - actual));
          flatErrors.push(Math.abs(flat - actual));
        }
      }
    }

    infraErrors.sort(function (a, b) {
      return a - b;
    });
    curveErrors.sort(function (a, b) {
      return a - b;
    });
    flatErrors.sort(function (a, b) {
      return a - b;
    });

    return {
      infra: medianOf(infraErrors),
      curve: medianOf(curveErrors),
      flat: medianOf(flatErrors),
      n: n
    };
  }

  window.TokenRadarModel = {
    fitValueModel: fitValueModel,
    fitSizeCurve: fitSizeCurve,
    isInfra: isInfra,
    fittedMultiple: fittedMultiple,
    sizeMultiple: sizeMultiple,
    impliedValue: impliedValue,
    backtest: backtest,
  };
})();
