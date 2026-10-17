// 同进程跑测试：`node --test` 会为每个文件 spawn 子进程并用管道收输出，
// 在受限沙箱里那会撞 EPERM（命名管道不可用）。直接 import 即可让
// node:test 在当前进程内执行并把 TAP 打到 stdout。
import './test/watch.test.mjs'
import './test/host.test.mjs'
import './test/client.test.mjs'
