import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;

/** Sequential TLC checks: fresh classloader/tool statics and output buffers per model. */
class TlcBatch {
    static final int MAGIC = 0x50414431;
    static final int LIMIT = 16 * 1024 * 1024;
    static volatile Capture activeOut, activeErr;
    static volatile String activeId;
    static final PrintStream diagnostics = System.err;
    static final List<Thread> retired = new CopyOnWriteArrayList<>();
    static boolean idleExecutor(Thread thread) {
        if (thread.getState()!=Thread.State.WAITING && thread.getState()!=Thread.State.TIMED_WAITING) return false;
        for (StackTraceElement frame:thread.getStackTrace()) {
            if (frame.getClassName().equals("java.util.concurrent.ThreadPoolExecutor") && frame.getMethodName().equals("getTask")) return true;
        }
        return false;
    }
    static String read(DataInputStream in) throws IOException {
        int size = in.readInt();
        if (size < 0 || size > LIMIT) throw new IOException("invalid frame length");
        byte[] data = in.readNBytes(size);
        if (data.length != size) throw new EOFException("incomplete frame");
        return new String(data, StandardCharsets.UTF_8);
    }
    static void write(DataOutputStream out, String text) throws IOException {
        byte[] data = text.getBytes(StandardCharsets.UTF_8);
        out.writeInt(data.length); out.write(data);
    }
    static class Capture extends OutputStream {
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        boolean exceeded;
        public synchronized void write(int value) {
            if (bytes.size() >= LIMIT) { exceeded = true; throw new IllegalStateException("TLC output limit"); }
            bytes.write(value);
        }
        public synchronized void write(byte[] data, int offset, int length) {
            if ((long) bytes.size() + length > LIMIT) { exceeded = true; throw new IllegalStateException("TLC output limit"); }
            bytes.write(data, offset, length);
        }
        String text() { return new String(bytes.toByteArray(), StandardCharsets.UTF_8); }
    }
    static class Result {
        int status; String stdout, stderr;
        Result(int status, String stdout, String stderr) { this.status=status; this.stdout=stdout; this.stderr=stderr; }
    }
    static Result check(String jar, String cwd, String model, String config) throws Exception {
        for (Thread thread:retired) if (thread.isAlive() && !idleExecutor(thread)) throw new IllegalStateException("retired TLC executor became active");
        PrintStream oldOut=System.out, oldErr=System.err;
        ClassLoader oldLoader=Thread.currentThread().getContextClassLoader();
        Capture output=new Capture(), errors=new Capture();
        activeOut=output; activeErr=errors;
        int status=1;
        try (URLClassLoader loader=new URLClassLoader(new URL[]{new File(jar).toURI().toURL()}, ClassLoader.getPlatformClassLoader());
             PrintStream out=new PrintStream(output,true,"UTF-8"); PrintStream err=new PrintStream(errors,true,"UTF-8")) {
            System.setOut(out); System.setErr(err);
            Thread.currentThread().setContextClassLoader(loader);
            Class<?> io=Class.forName("util.ToolIO",true,loader);
            io.getMethod("setUserDir",String.class).invoke(null,cwd);
            Class<?> type=Class.forName("tlc2.TLC",true,loader);
            Object tlc=type.getConstructor().newInstance();
            String[] args={"-workers","1","-metadir",new File(cwd,"meta").getPath(),"-config",new File(cwd,config).getPath(),new File(cwd,model).getPath()};
            boolean parameters=(Boolean)type.getMethod("handleParameters",String[].class).invoke(tlc,(Object)args);
            Method environment=type.getDeclaredMethod("checkEnvironment"); environment.setAccessible(true);
            if (parameters && (Boolean)environment.invoke(tlc)) {
                Class<?> resolver=Class.forName("util.SimpleFilenameToStream",true,loader);
                Object stream=resolver.getConstructor(String.class).newInstance(cwd);
                type.getMethod("setResolver",Class.forName("util.FilenameToStream",true,loader)).invoke(tlc,stream);
                Class<?> mailType=Class.forName("util.MailSender",true,loader);
                Object mail=mailType.getConstructor().newInstance();
                mailType.getMethod("setModelName",String.class).invoke(mail,type.getMethod("getModelName").invoke(tlc));
                mailType.getMethod("setSpecName",String.class).invoke(mail,type.getMethod("getSpecName").invoke(tlc));
                int code=(Integer)type.getMethod("process").invoke(tlc);
                boolean sent=(Boolean)mailType.getMethod("send",List.class).invoke(mail,type.getMethod("getModuleFiles").invoke(tlc));
                status=sent?(Integer)Class.forName("tlc2.output.EC$ExitStatus",true,loader).getMethod("errorConstantToExitStatus",int.class).invoke(null,code):1;
            }
            Object checker=Class.forName("tlc2.TLCGlobals",true,loader).getField("mainChecker").get(null);
            if (checker!=null) {
                Object queue=checker.getClass().getField("theStateQueue").get(checker);
                Class.forName("tlc2.tool.queue.IStateQueue",true,loader).getMethod("finishAll").invoke(queue);
            }
            for (Thread thread:Thread.getAllStackTraces().keySet()) {
                if (thread!=Thread.currentThread() && thread.isAlive() && thread.getContextClassLoader()==loader) {
                    // TLC 2.19 leaves an unreachable trace executor idle after a temporal violation.
                    // It has no producer after process() returns; never reuse it for another model.
                    if (!idleExecutor(thread)) thread.join(1000);
                    if (thread.isAlive()) {
                        if (!idleExecutor(thread)) throw new IllegalStateException("TLC model left an active thread: "+thread.getName());
                        thread.setContextClassLoader(ClassLoader.getPlatformClassLoader());
                        retired.add(thread);
                    }
                }
            }
            if (output.exceeded || errors.exceeded) throw new IllegalStateException("TLC output limit");
        } finally {
            Thread.currentThread().setContextClassLoader(oldLoader);
            System.setOut(oldOut); System.setErr(oldErr);
            activeOut=null; activeErr=null;
        }
        return new Result(status,output.text(),errors.text());
    }
    public static void main(String[] argv) throws Exception {
        Runtime.getRuntime().addShutdownHook(new Thread(()->{
            if(activeOut!=null) {
                diagnostics.println("TLC exited inside model: "+activeId);
                diagnostics.print(activeOut.text());
                if(activeErr!=null) diagnostics.print(activeErr.text());
            }
        },"tlc-abort-diagnostics"));
        DataInputStream in=new DataInputStream(System.in);
        DataOutputStream out=new DataOutputStream(System.out);
        if (in.readInt()!=MAGIC) throw new IOException("invalid request protocol");
        String jar=read(in); int count=in.readInt();
        if (count<1 || count>256) throw new IOException("invalid batch size");
        out.writeInt(MAGIC); out.writeInt(count); out.flush();
        for (int i=0;i<count;i++) {
            String id=read(in), digest=read(in), cwd=read(in), model=read(in), config=read(in);
            int timeout=in.readInt();
            if (timeout<1 || timeout>300000) throw new IOException("invalid model deadline");
            ExecutorService executor=Executors.newSingleThreadExecutor(task->{Thread t=new Thread(task,"tlc-model");t.setDaemon(true);return t;});
            activeId=id;
            Future<Result> future=executor.submit(()->check(jar,cwd,model,config));
            Result result;
            try { result=future.get(timeout,TimeUnit.MILLISECONDS); }
            catch (TimeoutException error) { System.err.println("TLC model timeout: "+id); System.exit(124); return; }
            catch (ExecutionException error) { System.err.println("TLC model aborted: "+id); error.getCause().printStackTrace(System.err); System.exit(1); return; }
            finally { executor.shutdownNow(); }
            write(out,id); write(out,digest); out.writeInt(result.status); out.writeLong(ProcessHandle.current().pid());
            write(out,result.stdout); write(out,result.stderr); out.flush();
        }
        // End the bounded batch, including TLC's retired, idle trace executors.
        System.exit(0);
    }
}
