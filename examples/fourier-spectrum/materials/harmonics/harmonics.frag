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
  vec4 n_n_mv2lw2qj7xtuh = vec4(0.0);
  vec2 n_n_mv2lw2qj3ighh = gl_FragCoord.xy / iResolution.xy;
  vec4 n_n_mv2lw2qj4smfp = vec4(max((n_n_mv2lw2qj7xtuh).x, step(abs((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).x - 0.0313), 0.0206) * step((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y, 0.9156) * step(0.18, (vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y)));
  vec4 n_n_mv2lw2qj4w00r = vec4(max((n_n_mv2lw2qj4smfp).x, step(abs((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).x - 0.0938), 0.0206) * step((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y, 0.4252) * step(0.18, (vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y)));
  vec4 n_n_mv2lw2qj93hw0 = vec4(max((n_n_mv2lw2qj4w00r).x, step(abs((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).x - 0.1563), 0.0206) * step((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y, 0.3271) * step(0.18, (vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y)));
  vec4 n_n_mv2lw2qj9yv2f = vec4(max((n_n_mv2lw2qj93hw0).x, step(abs((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).x - 0.2188), 0.0206) * step((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y, 0.2851) * step(0.18, (vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y)));
  vec4 n_n_mv2lw2qj6b5zs = vec4(max((n_n_mv2lw2qj9yv2f).x, step(abs((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).x - 0.2813), 0.0206) * step((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y, 0.2617) * step(0.18, (vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y)));
  vec4 n_n_mv2lw2qj2xl7l = vec4(max((n_n_mv2lw2qj6b5zs).x, step(abs((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).x - 0.3438), 0.0206) * step((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y, 0.2469) * step(0.18, (vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y)));
  vec4 n_n_mv2lw2qj8zk15 = vec4(max((n_n_mv2lw2qj2xl7l).x, step(abs((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).x - 0.4063), 0.0206) * step((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y, 0.2366) * step(0.18, (vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y)));
  vec4 n_n_mv2lw2qj4v633 = vec4(max((n_n_mv2lw2qj8zk15).x, step(abs((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).x - 0.4688), 0.0206) * step((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y, 0.2290) * step(0.18, (vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y)));
  vec4 n_n_mv2lw2qj9627r = vec4(mix(
vec3(0.03, 0.04, 0.06),
vec3(0.30, 0.90, 1.00), (n_n_mv2lw2qj4v633).x
) + vec3(0.06, 0.08, 0.11) * step(abs((vec4((n_n_mv2lw2qj3ighh).x, (n_n_mv2lw2qj3ighh).y, 0.0, 1.0)).y - 0.18), 0.0025), 1.0);
  st_fragColor = n_n_mv2lw2qj9627r;
}