// ================================================================
// AMA — Proposta 1 "Ateliê"  |  Interações da página
// ================================================================
(function () {
  "use strict";

  // Ano atual no rodapé
  var anoEl = document.getElementById("ano-atual");
  if (anoEl) anoEl.textContent = new Date().getFullYear();

  // Menu mobile
  var btnAbrir = document.querySelector("[data-abrir-menu]");
  var btnFechar = document.querySelector("[data-fechar-menu]");
  var menu = document.getElementById("menu-mobile");

  function abrirMenu() {
    menu.classList.add("aberto");
    document.body.style.overflow = "hidden";
  }
  function fecharMenu() {
    menu.classList.remove("aberto");
    document.body.style.overflow = "";
  }
  if (btnAbrir) btnAbrir.addEventListener("click", abrirMenu);
  if (btnFechar) btnFechar.addEventListener("click", fecharMenu);
  if (menu) {
    menu.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", fecharMenu);
    });
  }

  // Efeito visual do cabeçalho fixo ao rolar a página
  var topoEl = document.querySelector(".topo");
  if (topoEl) {
    var atualizarTopoScroll = function () {
      if (window.scrollY > 15) {
        topoEl.classList.add("topo--rolando");
      } else {
        topoEl.classList.remove("topo--rolando");
      }
    };
    window.addEventListener("scroll", atualizarTopoScroll, { passive: true });
    atualizarTopoScroll();
  }

  // Realce do link de navegação ativo por seção visível
  // (só âncoras desta página: links como /loja/ nunca ficam ativos aqui)
  var secoes = document.querySelectorAll("main section[id]");
  var linksNav = Array.prototype.filter.call(
    document.querySelectorAll(".nav-desktop a[href]"),
    function (a) {
      var href = a.getAttribute("href") || "";
      return href.length > 1 && href.charAt(0) === "#";
    }
  );
  if (secoes.length && linksNav.length && "IntersectionObserver" in window) {
    var obsNav = new IntersectionObserver(
      function (entradas) {
        entradas.forEach(function (entrada) {
          if (entrada.isIntersecting) {
            linksNav.forEach(function (l) {
              l.classList.toggle(
                "ativo",
                l.getAttribute("href") === "#" + entrada.target.id
              );
            });
          }
        });
      },
      { rootMargin: "-45% 0px -50% 0px" }
    );
    secoes.forEach(function (s) {
      obsNav.observe(s);
    });
  }

  // Revelar elementos ao rolar a página (com cascata para grades)
  var revelaveis = document.querySelectorAll(".reveal");
  var gradesEscalonadas = document.querySelectorAll(
    ".grade-produtos, .grade-plataforma, .grade-conteudo, .grade-depoimentos, .grade-redes"
  );
  gradesEscalonadas.forEach(function (grade) {
    var itens = grade.querySelectorAll(":scope > .reveal");
    itens.forEach(function (el, i) {
      el.style.transitionDelay = Math.min(i * 90, 360) + "ms";
    });
  });

  if ("IntersectionObserver" in window) {
    var obsRevela = new IntersectionObserver(
      function (entradas, obs) {
        entradas.forEach(function (entrada) {
          if (entrada.isIntersecting) {
            entrada.target.classList.add("visivel");
            obs.unobserve(entrada.target);
          }
        });
      },
      { threshold: 0.15 }
    );
    revelaveis.forEach(function (el) {
      obsRevela.observe(el);
    });
  } else {
    revelaveis.forEach(function (el) {
      el.classList.add("visivel");
    });
  }

  // A imagem de abertura inicia e conduz a leitura da história.
  var iniciarHistoria = document.querySelector("[data-historia-iniciar]");
  var historiaNarrativa = document.querySelector(".historia-narrativa");
  var historiaStory = historiaNarrativa ? historiaNarrativa.closest(".historia-story") : null;
  if (iniciarHistoria && historiaStory && historiaNarrativa) {
    iniciarHistoria.addEventListener("click", function () {
      historiaStory.classList.add("historia-iniciada");
      historiaNarrativa.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(function () { historiaNarrativa.focus({ preventScroll: true }); }, 500);
    });
  }

  // Modal Lightbox (ampliação de cartazes/projetos)
  var modalLightbox = document.getElementById("lightbox-modal");
  if (modalLightbox) {
    var lbImg = document.getElementById("lightbox-img");
    var lbLink = document.getElementById("lightbox-link");
    var btnFecharLb = modalLightbox.querySelector(".lightbox-fechar");
    var backdropLb = modalLightbox.querySelector(".lightbox-backdrop");

    // O conteúdo editável (CMS) troca o src da imagem e o href do link do cartão:
    // por isso o lightbox lê a imagem atual e o link do próprio cartão.
    var linkDoCartao = function (trigger) {
      var cartao = trigger.closest(".curso-simples, .historia-imagem-fixa, [data-cms-item]");
      if (!cartao) return null;
      var links = cartao.querySelectorAll("a[href]");
      for (var i = 0; i < links.length; i++) {
        if (!trigger.contains(links[i])) return links[i];
      }
      return null;
    };

    var abrirLightbox = function (trigger) {
      if (!trigger) return;
      var imgEl = trigger.querySelector("img");
      var src = imgEl ? (imgEl.currentSrc || imgEl.src) : "";
      if (!src) src = trigger.getAttribute("data-lightbox") || "";
      if (!src) return;
      var altTxt = (imgEl && imgEl.getAttribute("alt")) || "Imagem ampliada da AMA";
      var cartaoLink = linkDoCartao(trigger);
      var link = cartaoLink ? cartaoLink.getAttribute("href") : (trigger.getAttribute("data-link") || "");

      if (lbImg) {
        lbImg.src = src;
        lbImg.alt = altTxt;
      }
      if (lbLink) {
        if (link) {
          lbLink.setAttribute("href", link);
          var textoLink = cartaoLink ? cartaoLink.textContent.replace(/\s+/g, " ").trim() : "";
          lbLink.textContent = textoLink || "Conhecer";
          var alvoLink = cartaoLink ? cartaoLink.getAttribute("target") : "_blank";
          if (alvoLink) {
            lbLink.setAttribute("target", alvoLink);
            lbLink.setAttribute("rel", "noopener");
          } else {
            lbLink.removeAttribute("target");
          }
          lbLink.style.display = "";
        } else {
          lbLink.style.display = "none";
        }
      }

      modalLightbox.hidden = false;
      modalLightbox.offsetHeight; // reflow
      modalLightbox.classList.add("ativo");
      document.body.style.overflow = "hidden";
    };

    var fecharLightbox = function () {
      modalLightbox.classList.remove("ativo");
      document.body.style.overflow = "";
      setTimeout(function () {
        if (!modalLightbox.classList.contains("ativo")) {
          modalLightbox.hidden = true;
          if (lbImg) lbImg.removeAttribute("src");
        }
      }, 300);
    };

    document.querySelectorAll("[data-lightbox]").forEach(function (btn) {
      // Nome acessível segue o texto alternativo atual da imagem (editável no painel, pode vir vazio).
      var imgBtn = btn.querySelector("img");
      var altBtn = imgBtn ? (imgBtn.getAttribute("alt") || "").trim() : "";
      btn.setAttribute("aria-label", altBtn ? "Ampliar imagem: " + altBtn : "Ampliar imagem");
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        abrirLightbox(btn);
      });
    });

    // Link interno (#secao) no lightbox: fecha a ampliação antes de rolar.
    if (lbLink) {
      lbLink.addEventListener("click", function () {
        var href = lbLink.getAttribute("href") || "";
        if (href.charAt(0) === "#") fecharLightbox();
      });
    }

    if (btnFecharLb) {
      btnFecharLb.addEventListener("click", fecharLightbox);
    }
    if (backdropLb) {
      backdropLb.addEventListener("click", fecharLightbox);
    }
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !modalLightbox.hidden) {
        fecharLightbox();
      }
    });
  }
  if (window.instgrm && window.instgrm.Embeds) {
    window.instgrm.Embeds.process();
  }

  // Carrossel de Projetos (scrollável com setas)
  var carrosselProjetos = document.getElementById("carrossel-projetos");
  if (carrosselProjetos) {
    var setaPrevProj = document.querySelector(".projetos-seta--prev");
    var setaNextProj = document.querySelector(".projetos-seta--next");
    var passoProjetos = function () {
      var cartao = carrosselProjetos.querySelector(".curso-simples");
      if (!cartao) return 360;
      var estilo = window.getComputedStyle(carrosselProjetos);
      var gap = parseFloat(estilo.columnGap || estilo.gap || "26") || 26;
      return cartao.getBoundingClientRect().width + gap;
    };
    if (setaPrevProj) {
      setaPrevProj.addEventListener("click", function () {
        carrosselProjetos.scrollBy({ left: -passoProjetos(), behavior: "smooth" });
      });
    }
    if (setaNextProj) {
      setaNextProj.addEventListener("click", function () {
        carrosselProjetos.scrollBy({ left: passoProjetos(), behavior: "smooth" });
      });
    }
    var atualizarSetasProjetos = function () {
      var folga = 6;
      var temOverflow = carrosselProjetos.scrollWidth > carrosselProjetos.clientWidth + folga;
      if (setaPrevProj) {
        setaPrevProj.style.display = temOverflow ? "grid" : "none";
        setaPrevProj.disabled = carrosselProjetos.scrollLeft <= folga;
      }
      if (setaNextProj) {
        var noFim = carrosselProjetos.scrollLeft + carrosselProjetos.clientWidth >= carrosselProjetos.scrollWidth - folga;
        setaNextProj.style.display = temOverflow ? "grid" : "none";
        setaNextProj.disabled = noFim;
      }
    };
    atualizarSetasProjetos();
    carrosselProjetos.addEventListener("scroll", atualizarSetasProjetos);
    window.addEventListener("resize", atualizarSetasProjetos);
  }

  // Formulário de contato (demonstrativo — sem envio real)
  var form = document.getElementById("form-contato");
  if (form) {
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var aviso = form.querySelector(".form-aviso");
      if (aviso) {
        aviso.textContent =
          "Mensagem de demonstração — nesta proposta o formulário ainda não envia dados de verdade.";
      }
    });
  }

  // Player de Vídeo Institucional
  var player = document.getElementById("player-institucional");
  if (player) {
    var video = player.querySelector("video");
    var overlayPlay = player.querySelector(".pv-overlay-play");
    var btnPlay = player.querySelector(".pv-btn-play");
    var btnVolume = player.querySelector(".pv-btn-volume");
    var sliderVolume = player.querySelector(".pv-slider-volume");
    var btnReiniciar = player.querySelector(".pv-btn-reiniciar");
    var btnTelaCheia = player.querySelector(".pv-btn-tela-cheia");
    var barraProgresso = player.querySelector(".pv-barra-progresso");
    var progressoPreenchido = player.querySelector(".pv-progresso-preenchido");
    var progressoBuffer = player.querySelector(".pv-progresso-buffer");
    var progressoMarcador = player.querySelector(".pv-progresso-marcador");
    var tempoAtual = player.querySelector(".pv-tempo-atual");
    var tempoTotal = player.querySelector(".pv-tempo-total");

    var arrastandoProgresso = false;
    var ultimoVolume = 0.8;
    var timerOcultar;

    function formatarTempo(segundos) {
      if (isNaN(segundos) || !isFinite(segundos)) return "0:00";
      var s = Math.floor(segundos);
      var min = Math.floor(s / 60);
      var seg = s % 60;
      return min + ":" + (seg < 10 ? "0" : "") + seg;
    }

    function togglePlay(ev) {
      if (ev) ev.stopPropagation();
      if (!video) return;
      if (video.paused || video.ended) {
        video.play().catch(function () {});
      } else {
        video.pause();
      }
    }

    if (video) {
      video.addEventListener("click", togglePlay);
      video.addEventListener("play", function () {
        player.classList.remove("pausado");
        if (btnPlay) btnPlay.setAttribute("aria-label", "Pausar");
        if (overlayPlay) overlayPlay.setAttribute("aria-label", "Pausar vídeo");
        reiniciarTimerOcultar();
      });
      video.addEventListener("pause", function () {
        player.classList.add("pausado");
        player.classList.remove("ocultar-controles");
        if (btnPlay) btnPlay.setAttribute("aria-label", "Reproduzir");
        if (overlayPlay) overlayPlay.setAttribute("aria-label", "Reproduzir vídeo");
        clearTimeout(timerOcultar);
      });
      video.addEventListener("ended", function () {
        player.classList.add("pausado");
        player.classList.remove("ocultar-controles");
      });

      // Atualização de tempo e barra de progresso
      video.addEventListener("timeupdate", function () {
        if (tempoAtual) tempoAtual.textContent = formatarTempo(video.currentTime);
        if (!arrastandoProgresso && video.duration) {
          var pct = (video.currentTime / video.duration) * 100;
          if (progressoPreenchido) progressoPreenchido.style.width = pct + "%";
          if (progressoMarcador) progressoMarcador.style.left = pct + "%";
          if (barraProgresso) barraProgresso.setAttribute("aria-valuenow", Math.round(pct));
        }
      });

      video.addEventListener("loadedmetadata", function () {
        if (tempoTotal) tempoTotal.textContent = formatarTempo(video.duration);
        if (tempoAtual) tempoAtual.textContent = formatarTempo(video.currentTime);
      });

      video.addEventListener("durationchange", function () {
        if (tempoTotal) tempoTotal.textContent = formatarTempo(video.duration);
      });

      video.addEventListener("progress", function () {
        if (video.buffered.length > 0 && video.duration && progressoBuffer) {
          var fimBuffer = video.buffered.end(video.buffered.length - 1);
          progressoBuffer.style.width = Math.min((fimBuffer / video.duration) * 100, 100) + "%";
        }
      });
    }

    if (overlayPlay) overlayPlay.addEventListener("click", togglePlay);
    if (btnPlay) btnPlay.addEventListener("click", togglePlay);

    // Barra de progresso interativa
    if (barraProgresso && video) {
      function calcularPosicaoProgresso(ev) {
        var rect = barraProgresso.getBoundingClientRect();
        var clientX = ev.clientX !== undefined ? ev.clientX : (ev.touches && ev.touches[0] ? ev.touches[0].clientX : 0);
        var pos = (clientX - rect.left) / rect.width;
        return Math.max(0, Math.min(1, pos));
      }

      function aplicarProgresso(ev) {
        var pos = calcularPosicaoProgresso(ev);
        if (video.duration) {
          video.currentTime = pos * video.duration;
        }
        var pct = pos * 100;
        if (progressoPreenchido) progressoPreenchido.style.width = pct + "%";
        if (progressoMarcador) progressoMarcador.style.left = pct + "%";
        if (tempoAtual) tempoAtual.textContent = formatarTempo(pos * (video.duration || 0));
      }

      barraProgresso.addEventListener("pointerdown", function (ev) {
        arrastandoProgresso = true;
        barraProgresso.classList.add("arrastando");
        if (barraProgresso.setPointerCapture) {
          barraProgresso.setPointerCapture(ev.pointerId);
        }
        aplicarProgresso(ev);
        reiniciarTimerOcultar();
      });

      barraProgresso.addEventListener("pointermove", function (ev) {
        if (!arrastandoProgresso) return;
        aplicarProgresso(ev);
      });

      function soltarProgresso(ev) {
        if (arrastandoProgresso) {
          arrastandoProgresso = false;
          barraProgresso.classList.remove("arrastando");
          reiniciarTimerOcultar();
        }
      }
      barraProgresso.addEventListener("pointerup", soltarProgresso);
      barraProgresso.addEventListener("pointercancel", soltarProgresso);

      // Acessibilidade via teclado na barra de progresso
      barraProgresso.addEventListener("keydown", function (ev) {
        if (!video.duration) return;
        if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") {
          ev.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 5);
        } else if (ev.key === "ArrowRight" || ev.key === "ArrowUp") {
          ev.preventDefault();
          video.currentTime = Math.min(video.duration, video.currentTime + 5);
        }
      });
    }

    // Volume e Mudo
    function atualizarEstadoVolume() {
      if (!video) return;
      var estaMudo = video.muted || video.volume === 0;
      player.classList.toggle("mudo", estaMudo);
      if (sliderVolume) {
        sliderVolume.value = estaMudo ? 0 : video.volume;
      }
      if (btnVolume) {
        btnVolume.setAttribute("aria-label", estaMudo ? "Ativar som" : "Desativar som");
      }
    }

    function alternarMudo(ev) {
      if (ev) ev.stopPropagation();
      if (!video) return;
      if (video.muted || video.volume === 0) {
        video.muted = false;
        video.volume = ultimoVolume > 0 ? ultimoVolume : 0.8;
      } else {
        ultimoVolume = video.volume > 0 ? video.volume : 0.8;
        video.muted = true;
      }
      atualizarEstadoVolume();
    }

    if (btnVolume) btnVolume.addEventListener("click", alternarMudo);

    if (sliderVolume && video) {
      sliderVolume.addEventListener("input", function (ev) {
        ev.stopPropagation();
        var val = parseFloat(this.value);
        video.volume = val;
        video.muted = (val === 0);
        if (val > 0) ultimoVolume = val;
        atualizarEstadoVolume();
      });
      sliderVolume.addEventListener("click", function (ev) {
        ev.stopPropagation();
      });
    }

    // Reiniciar
    if (btnReiniciar && video) {
      btnReiniciar.addEventListener("click", function (ev) {
        ev.stopPropagation();
        video.currentTime = 0;
        video.play().catch(function () {});
      });
    }

    // Tela Cheia
    function alternarTelaCheia(ev) {
      if (ev) ev.stopPropagation();
      var elemCheia = document.fullscreenElement || document.webkitFullscreenElement;
      if (!elemCheia) {
        if (player.requestFullscreen) {
          player.requestFullscreen();
        } else if (player.webkitRequestFullscreen) {
          player.webkitRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
      }
    }

    if (btnTelaCheia) btnTelaCheia.addEventListener("click", alternarTelaCheia);

    function onFullscreenChange() {
      var cheia = !!(document.fullscreenElement || document.webkitFullscreenElement);
      player.classList.toggle("tela-cheia", cheia);
      if (btnTelaCheia) {
        btnTelaCheia.setAttribute("aria-label", cheia ? "Sair da tela cheia" : "Tela cheia");
      }
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);

    // Ocultar controles automaticamente com inatividade
    function reiniciarTimerOcultar() {
      player.classList.remove("ocultar-controles");
      clearTimeout(timerOcultar);
      if (video && !video.paused) {
        timerOcultar = setTimeout(function () {
          if (video && !video.paused && !arrastandoProgresso) {
            player.classList.add("ocultar-controles");
          }
        }, 2500);
      }
    }

    player.addEventListener("mousemove", reiniciarTimerOcultar);
    player.addEventListener("touchstart", reiniciarTimerOcultar, { passive: true });
    player.addEventListener("mouseleave", function () {
      if (video && !video.paused && !arrastandoProgresso) {
        player.classList.add("ocultar-controles");
      }
    });

    // Atalhos de teclado no player
    player.addEventListener("keydown", function (ev) {
      if (document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA")) return;
      var tecla = ev.key.toLowerCase();
      if (tecla === " " || tecla === "k") {
        ev.preventDefault();
        togglePlay();
      } else if (tecla === "m") {
        ev.preventDefault();
        alternarMudo();
      } else if (tecla === "f") {
        ev.preventDefault();
        alternarTelaCheia();
      } else if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 5);
      } else if (ev.key === "ArrowRight") {
        ev.preventDefault();
        video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
      }
    });

    // Estado inicial
    if (video) {
      if (video.paused) {
        player.classList.add("pausado");
      } else {
        player.classList.remove("pausado");
      }
      atualizarEstadoVolume();
      if (video.readyState >= 1) {
        if (tempoTotal) tempoTotal.textContent = formatarTempo(video.duration);
        if (tempoAtual) tempoAtual.textContent = formatarTempo(video.currentTime);
      }
    }
  }
})();
