#version 300 es
precision highp float;
precision highp int;

uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform vec4 iMouse;
uniform vec4 iDate;

out vec4 st_fragColor;



void main() {
  vec2 n_n_mv2lw2pg6lxoy = gl_FragCoord.xy / iResolution.xy;
  vec4 n_n_mv2lw2pg3q1rp = vec4(0.0);
  vec4 n_n_mv2lw2pg9t853 = vec4((n_n_mv2lw2pg3q1rp).x + 1.273240 * sin(6.283185307179586 * 1.0 * (vec4((n_n_mv2lw2pg6lxoy).x, (n_n_mv2lw2pg6lxoy).y, 0.0, 1.0)).x * 2.0), 0.0, 0.0, 1.0);
  vec4 n_n_mv2lw2pg3rpe5 = vec4((n_n_mv2lw2pg9t853).x + 0.424413 * sin(6.283185307179586 * 3.0 * (vec4((n_n_mv2lw2pg6lxoy).x, (n_n_mv2lw2pg6lxoy).y, 0.0, 1.0)).x * 2.0), 0.0, 0.0, 1.0);
  vec4 n_n_mv2lw2pg3dnbt = vec4((n_n_mv2lw2pg3rpe5).x + 0.254648 * sin(6.283185307179586 * 5.0 * (vec4((n_n_mv2lw2pg6lxoy).x, (n_n_mv2lw2pg6lxoy).y, 0.0, 1.0)).x * 2.0), 0.0, 0.0, 1.0);
  vec4 n_n_mv2lw2pg16oom = vec4((n_n_mv2lw2pg3dnbt).x + 0.181891 * sin(6.283185307179586 * 7.0 * (vec4((n_n_mv2lw2pg6lxoy).x, (n_n_mv2lw2pg6lxoy).y, 0.0, 1.0)).x * 2.0), 0.0, 0.0, 1.0);
  vec4 n_n_mv2lw2pg5fqxc = vec4((n_n_mv2lw2pg16oom).x + 0.141471 * sin(6.283185307179586 * 9.0 * (vec4((n_n_mv2lw2pg6lxoy).x, (n_n_mv2lw2pg6lxoy).y, 0.0, 1.0)).x * 2.0), 0.0, 0.0, 1.0);
  vec4 n_n_mv2lw2pg6b8c5 = vec4((n_n_mv2lw2pg5fqxc).x + 0.115749 * sin(6.283185307179586 * 11.0 * (vec4((n_n_mv2lw2pg6lxoy).x, (n_n_mv2lw2pg6lxoy).y, 0.0, 1.0)).x * 2.0), 0.0, 0.0, 1.0);
  vec4 n_n_mv2lw2pg72mq6 = vec4(mix(
mix(vec3(0.03, 0.04, 0.06), vec3(0.34, 0.38, 0.46),
smoothstep(0.010, 0.0, abs(((vec4((n_n_mv2lw2pg6lxoy).x, (n_n_mv2lw2pg6lxoy).y, 0.0, 1.0)).y * 2.0 - 1.0) - (fract((vec4((n_n_mv2lw2pg6lxoy).x, (n_n_mv2lw2pg6lxoy).y, 0.0, 1.0)).x * 2.0) < 0.5 ? 1.0 : -1.0)))
 * (fract((vec4((n_n_mv2lw2pg6lxoy).x, (n_n_mv2lw2pg6lxoy).y, 0.0, 1.0)).x * 90.0) < 0.55 ? 1.0 : 0.12)),
vec3(0.25, 0.95, 1.0),
smoothstep(0.008, 0.0, abs(((vec4((n_n_mv2lw2pg6lxoy).x, (n_n_mv2lw2pg6lxoy).y, 0.0, 1.0)).y * 2.0 - 1.0) - (n_n_mv2lw2pg6b8c5).x * 0.80))
), 1.0);
  st_fragColor = n_n_mv2lw2pg72mq6;
}